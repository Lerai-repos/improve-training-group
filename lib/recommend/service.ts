import { log } from '@lib/logger';
import type { Acknowledgements } from '@lib/monday';
import { tryResolveHourlyRateCents, type RateCard, type TravelTimeConfig } from '@lib/calc';

import {
  ADDRESS_MODEL,
  ADDRESS_PROMPT_VERSION,
  type AddressDecision,
  type AddressFormatter,
} from './address';
import type { InputArtifact } from './artifact';
import { hashArtifact } from './artifact';
import { computeEffectiveQuals, filterEligible } from './eligibility';
import { priceTrainer, rankTrainers, type PricingContext } from './pricing';
import { computeScores } from './scores';
import type { TravelProvider } from './travel';
import { resolveTravel, type TravelCache } from './travel-resolve';
import { toStoredRows, type StoredRow } from './view-row';
import type {
  CandidateTrainer,
  QualObservation,
  RankedRecommendation,
  TrainerThemeEval,
  TrainerTravel,
} from './types';

/** The just-edited training, live-read from Monday (authoritative for the trigger). */
export interface LiveTraining {
  externalItemId: string;
  themeExternalIds: string[];
  locatie: string | null;
  datum: string | null;
  duurTraining: number | null;
  updatedAt: string;
}

/** Live Monday reads (the correctness-critical, volatile inputs). */
export interface LiveMondayReader {
  readTraining(itemId: string): Promise<LiveTraining | null>;
  readThemeQualifications(themeExternalIds: readonly string[]): Promise<QualObservation[]>;
}

export interface EngineConfig {
  boardId: string;
  hqAddress: string;
  recommendableGroups: string[];
  rateCards: RateCard[];
  travelTimeConfig: TravelTimeConfig;
  trainerTravelRateCentsPerKm: number;
  clientTravelRateCentsPerKm: number;
  gitSha: string | null;
  ackVersion: string | null;
}

export interface ServiceDeps {
  reader: LiveMondayReader;
  /**
   * The FULL live trainer roster, every group included, fetched ONCE per execution
   * and injected. The board read costs several Monday calls, so re-reading it per
   * training would multiply that against a 25.000/day budget. Group filtering
   * happens below, not in the roster adapter — see `lib/recommend/roster.ts`.
   */
  roster: readonly CandidateTrainer[];
  addressFormatter: AddressFormatter;
  travelProvider: TravelProvider;
  travelCache: TravelCache;
  ack: Acknowledgements;
  config: EngineConfig;
}

/** Where a run stopped. `freshness`/`persist` are gone with the snapshot and the DB. */
export type Stage =
  | 'load_training'
  | 'validate_training'
  | 'invalid_duration'
  | 'invalid_date'
  | 'eligibility'
  | 'rates'
  | 'address'
  | 'travel'
  | 'pricing';

/** Recorded as-is on the run; nothing populates it yet, so it stays null. */
export type ProviderErrors = null;

interface Counts {
  candidate: number;
  eligible: number;
  recommended: number;
}

interface Provenance {
  artifact: InputArtifact;
  artifactHash: string;
  counts: Counts;
  excluded: Array<{ externalItemId: string; reason: string }>;
  /**
   * `null` means the address stage was NOT EVALUATED (we short-circuited before any
   * provider call). A confirmed-online training is a real decision — kind
   * `no_travel_confirmed` — and must be preserved, not flattened to null.
   */
  addressDecision: AddressDecision | null;
  providerErrors: ProviderErrors;
  /** `LiveTraining.updatedAt` — which revision of the training this answer came from. */
  mondayItemRevision: string | null;
  travelCacheHits: number;
}

/**
 * The complete outcome. A discriminated union because provenance accumulates as
 * the pipeline runs: a failure at `load_training` has no artifact and no counts,
 * so a flat all-required shape would be a lie.
 */
export type RecommendationResult =
  | ({
      ok: true;
      resultStatus: 'GEREED' | 'GEEN MATCH';
      recommendations: RankedRecommendation[];
      /**
       * The same list as `recommendations`, shaped for persistence and the item view:
       * ids and numbers only, per-theme qualification attached. Built here rather than
       * in the job because the qualification matrix is only in scope at this point.
       */
      rows: StoredRow[];
    } & Provenance)
  | {
      ok: false;
      resultStatus: 'FOUT';
      /**
       * `retryable` decides what the job route does with this, and the stage alone
       * cannot tell you: `travel` is a Routes outage one moment and an unreachable
       * destination the next. A retryable failure must NOT record a terminal outcome
       * — it returns non-2xx and lets the queue try again. A terminal one records
       * FOUT and tells the queue to stop.
       */
      failure: { stage: Stage; message: string | null; retryable: boolean };
      partial: Partial<Provenance>;
    };

/**
 * Evaluation aggregates are INERT until M3 (see scores.ts): every input row is
 * absent today, so scores are (null, 0) and ranking falls back to cost then travel.
 * They were the one input with no live-Monday equivalent — derived history, not a
 * column — so they are dropped here and will return from the Trainer x Thema board.
 */
const NO_EVALS: readonly TrainerThemeEval[] = [];

function addressReason(addr: AddressDecision): string | null {
  if (addr.kind === 'no_travel_confirmed') {
    return addr.reason;
  }
  if (addr.kind === 'unresolved_location' || addr.kind === 'error') {
    return addr.detail;
  }
  return null;
}

/** Cap on the persisted/logged failure detail (avoid unbounded error strings). */
const MAX_ERROR_DETAIL = 500;

/**
 * The full compute pipeline for one training. Pure orchestration over injected
 * ports: it reads Monday live, computes, and RETURNS the answer — persistence and
 * delivery are the caller's business.
 *
 * There is no freshness gate any more. It existed because the trainer roster came
 * from a periodic snapshot that could go stale; reading Monday live removes the
 * failure mode rather than guarding it.
 */
export async function runRecommendation(
  deps: ServiceDeps,
  mondayItemId: string
): Promise<RecommendationResult> {
  const { config } = deps;
  let stage: Stage = 'load_training';
  const excluded: Array<{ externalItemId: string; reason: string }> = [];
  let addr: AddressDecision | null = null;
  let travelCacheHits = 0;
  let mondayItemRevision: string | null = null;

  const fail = (
    failingStage: Stage,
    message: string | null = null,
    retryable = false
  ): RecommendationResult => ({
    ok: false,
    resultStatus: 'FOUT',
    failure: { stage: failingStage, message, retryable },
    // Whatever provenance existed when it failed — never fabricated.
    partial: { excluded, addressDecision: addr, travelCacheHits, mondayItemRevision },
  });

  try {
    const live = await deps.reader.readTraining(mondayItemId);
    if (!live) {
      // Not retryable: a Monday outage THROWS (and is caught below); a null here
      // means the item genuinely is not on the board.
      return fail('load_training');
    }
    mondayItemRevision = live.updatedAt;

    // Group filtering lives HERE, not in the roster adapter: `groups:list` and the
    // readiness API need the unfiltered roster to report on unselected groups.
    const groups = new Set(config.recommendableGroups);
    const candidates = deps.roster.filter(
      (t) => t.mondayGroup !== null && groups.has(t.mondayGroup)
    );

    // A training that HAS themes must carry valid scheduling input. Validate before
    // eligibility so invalid input is FOUT even when zero trainers are eligible —
    // otherwise a present-but-empty date/duration silently rides a GEEN MATCH out.
    // (Zero-theme is a legitimate GEEN MATCH and is left to eligibility below.)
    stage = 'validate_training';
    if (live.themeExternalIds.length > 0) {
      const dur = live.duurTraining;
      if (dur === null || !Number.isFinite(dur) || dur <= 0) {
        return fail('invalid_duration');
      }
      if (!live.datum || live.datum.trim() === '') {
        return fail('invalid_date');
      }
    }

    stage = 'eligibility';
    const observations = await deps.reader.readThemeQualifications(live.themeExternalIds);
    const effective = computeEffectiveQuals(observations, deps.ack);
    const eligible = filterEligible(live.themeExternalIds, candidates, effective);

    // Resolve rates BEFORE any provider call. A trainer we cannot price is dropped
    // here with a reason instead of throwing at the pricing stage — otherwise a
    // configured-but-unrated group (e.g. one selected in RECOMMENDABLE_TRAINER_GROUPS
    // whose trainers have no rate card) would fail the WHOLE run as FOUT. Doing it
    // before address/travel also means such a trainer can't trigger a transient route
    // failure that would fail a run we were going to exclude them from anyway.
    stage = 'rates';
    const priceable = eligible.filter((t) => {
      const rate =
        t.rateKey === null
          ? null
          : tryResolveHourlyRateCents(
              config.rateCards,
              t.rateKey,
              t.externalItemId,
              live.datum ?? ''
            );
      if (rate === null) {
        excluded.push({ externalItemId: t.externalItemId, reason: 'no_rate' });
        return false;
      }
      return true;
    });

    // Qualified trainers existed but NONE could be priced. On the board that is
    // indistinguishable from a genuine no-match, so say so loudly here — it means a
    // selected group has no usable rate cards (see `pnpm groups:list`), which is a
    // configuration fault, not an answer.
    if (eligible.length > 0 && priceable.length === 0) {
      log.error('all eligible trainers excluded as no_rate — check RECOMMENDABLE_TRAINER_GROUPS', {
        mondayItemId,
        eligible: eligible.length,
        excludedNoRate: excluded.length,
      });
    }

    // With NO priceable trainer, GEEN MATCH is already definitive: there is nothing to
    // price, so the address LLM and the Routes calls are pure risk — a provider hiccup
    // there would turn a decided GEEN MATCH into a spurious FOUT. Skip both.
    const travelByTrainer = new Map<string, TrainerTravel | null>();
    let routes: InputArtifact['enrichment']['routes'] = [];

    if (priceable.length > 0) {
      stage = 'address';
      const decision = await deps.addressFormatter.format(live.locatie);
      if (decision.kind === 'error' || decision.kind === 'unresolved_location') {
        // `error` is a model/parse failure — worth another attempt. `unresolved_location`
        // means the model understood the field and the field is unusable: retrying
        // cannot change that, only editing Locatie can.
        return fail('address', decision.detail, decision.kind === 'error');
      }
      addr = decision;

      stage = 'travel';
      if (decision.kind === 'no_travel_confirmed') {
        for (const t of priceable) {
          travelByTrainer.set(t.externalItemId, null);
        }
      } else {
        const resolved = await resolveTravel(deps.travelCache, deps.travelProvider, {
          destination: decision.formatted,
          hqAddress: config.hqAddress,
          trainers: priceable,
        });
        if (resolved.kind === 'fout') {
          return fail('travel', resolved.detail, resolved.retryable);
        }
        // APPEND — assigning here would discard the no_rate exclusions collected above.
        excluded.push(...resolved.excluded);
        routes = resolved.routes;
        travelCacheHits = resolved.cacheHits;
        for (const t of priceable) {
          travelByTrainer.set(t.externalItemId, resolved.byTrainer.get(t.externalItemId) ?? null);
        }
      }
    }

    stage = 'pricing';
    const excludedIds = new Set(excluded.map((e) => e.externalItemId));
    const included = priceable.filter((t) => !excludedIds.has(t.externalItemId));
    // Duration/date were validated up front (any eligible trainer implies themes > 0,
    // which the validate_training stage already gated) and every remaining trainer has
    // a resolvable rate, so pricing input is sound here.
    const ctx: PricingContext = {
      trainingDate: live.datum ?? '',
      duurTraining: live.duurTraining ?? 0,
      rateCards: config.rateCards,
      travelTimeConfig: config.travelTimeConfig,
      trainerTravelRateCentsPerKm: config.trainerTravelRateCentsPerKm,
      clientTravelRateCentsPerKm: config.clientTravelRateCentsPerKm,
    };
    const computed = included.map((t) =>
      priceTrainer(
        t,
        travelByTrainer.get(t.externalItemId) ?? null,
        computeScores(t.externalItemId, live.themeExternalIds, NO_EVALS),
        ctx
      )
    );
    const ranked: RankedRecommendation[] = rankTrainers(computed);

    const artifact: InputArtifact = {
      version: 3,
      code: { gitSha: config.gitSha, calcVersion: '1' },
      training: {
        externalItemId: live.externalItemId,
        datum: live.datum,
        duurTraining: live.duurTraining,
        themeExternalIds: live.themeExternalIds,
      },
      qualifications: {
        observations: observations.map((o) => ({
          trainerExternalId: o.trainerExternalId,
          themaExternalId: o.themaExternalId,
          colour: o.colour,
        })),
        effective: effective.map((e) => ({
          trainerExternalId: e.trainerExternalId,
          themaExternalId: e.themaExternalId,
          effective: e.effective,
          conflicted: e.conflicted,
        })),
        ackVersion: config.ackVersion,
      },
      trainers: eligible.map((t) => ({
        externalItemId: t.externalItemId,
        mondayGroup: t.mondayGroup,
        rateKey: t.rateKey,
      })),
      scores: ranked.map((r) => ({
        trainerExternalId: r.externalItemId,
        themeAvgScore: r.themeAvgScore,
        overallAvgScore: r.overallAvgScore,
      })),
      rates: {
        // No snapshot to point at any more — the roster is read live from Monday.
        inputSyncRunId: null,
        rateCards: config.rateCards,
        travelTimeConfig: config.travelTimeConfig,
        trainerTravelRateCentsPerKm: config.trainerTravelRateCentsPerKm,
        clientTravelRateCentsPerKm: config.clientTravelRateCentsPerKm,
      },
      enrichment: {
        // `not_evaluated` = we short-circuited (no eligible trainer), so no external
        // call was made — recording a model/decision here would misrepresent the audit.
        addressDecisionKind: addr === null ? 'not_evaluated' : addr.kind,
        addressReason: addr === null ? null : addressReason(addr),
        model: addr === null ? null : ADDRESS_MODEL,
        promptVersion: addr === null ? null : ADDRESS_PROMPT_VERSION,
        routingProfile: 'TRAFFIC_UNAWARE',
        routes,
      },
    };

    return {
      ok: true,
      resultStatus: ranked.length > 0 ? 'GEREED' : 'GEEN MATCH',
      recommendations: ranked,
      rows: toStoredRows(ranked, effective, live.themeExternalIds),
      artifact,
      artifactHash: hashArtifact(artifact),
      counts: {
        candidate: candidates.length,
        eligible: eligible.length,
        recommended: ranked.length,
      },
      excluded,
      addressDecision: addr,
      providerErrors: null,
      mondayItemRevision,
      travelCacheHits,
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_DETAIL
    );
    log.error('recommendation run failed', { mondayItemId, stage, detail });
    // A THROWN error is infrastructure — a Monday 5xx, a socket reset, a timeout.
    // Business rejections all return through `fail` above, so anything reaching here
    // is worth retrying rather than burning into a terminal FOUT.
    return fail(stage, detail, true);
  }
}
