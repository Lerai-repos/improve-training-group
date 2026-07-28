import { z } from 'zod';

import type { SupabaseClient } from '@supabase/supabase-js';

import { log } from '@lib/logger';
import type { Acknowledgements } from '@lib/monday';
import type { RateCard, TravelTimeConfig } from '@lib/calc';
import type { Database } from '@lib/types/database';

import {
  ADDRESS_MODEL,
  ADDRESS_PROMPT_VERSION,
  type AddressDecision,
  type AddressFormatter,
} from './address';
import type { InputArtifact } from './artifact';
import { hashArtifact } from './artifact';
import { computeEffectiveQuals, filterEligible } from './eligibility';
import { markRunFailed, persistRecommendations, updateRunProvenance } from './persist';
import { priceTrainer, rankTrainers, type PricingContext } from './pricing';
import { computeScores } from './scores';
import type { TravelProvider } from './travel';
import { resolveTravel, type TravelCache } from './travel-resolve';
import type {
  CandidateTrainer,
  QualObservation,
  RankedRecommendation,
  TrainerThemeEval,
  TrainerTravel,
} from './types';

type Admin = SupabaseClient<Database>;

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
  /** Max age of the latest OK M2a sync before the snapshot is too stale to recommend on. */
  snapshotMaxAgeMs: number;
  gitSha: string | null;
  ackVersion: string | null;
}

export interface ServiceDeps {
  admin: Admin;
  reader: LiveMondayReader;
  addressFormatter: AddressFormatter;
  travelProvider: TravelProvider;
  travelCache: TravelCache;
  ack: Acknowledgements;
  config: EngineConfig;
}

/** The minimal shape of a claimed run this pipeline needs. */
export interface ClaimedRun {
  id: string;
  monday_item_id: string;
  generation: number;
}

export interface RunOutcome {
  ok: boolean;
  resultStatus: 'GEREED' | 'GEEN MATCH' | 'FOUT' | null;
  superseded?: boolean;
  failingStage?: string;
}

const inputsSchema = z.object({
  sync_run_id: z.string().nullable(),
  sync_run_started_at: z.string().nullable(),
  trainers: z.array(
    z.object({
      external_item_id: z.string(),
      naam: z.string().nullable(),
      adres: z.string().nullable(),
      monday_group: z.string().nullable(),
      rate_key: z.string().nullable(),
    })
  ),
  trainer_theme_evals: z.array(
    z.object({
      trainer_ext: z.string(),
      thema_ext: z.string(),
      avg_overall_grade: z.number().nullable(),
      evaluation_count: z.number().nullable(),
    })
  ),
});

interface SnapshotInputs {
  syncRunId: string | null;
  syncStartedAt: string | null;
  trainers: CandidateTrainer[];
  evals: TrainerThemeEval[];
}

async function readInputs(admin: Admin, groups: string[]): Promise<SnapshotInputs> {
  const { data, error } = await admin.rpc('read_recommendation_inputs', { p_groups: groups });
  if (error) {
    throw new Error(`read_recommendation_inputs: ${error.message}`);
  }
  const parsed = inputsSchema.parse(data);
  return {
    syncRunId: parsed.sync_run_id,
    syncStartedAt: parsed.sync_run_started_at,
    trainers: parsed.trainers.map((t) => ({
      externalItemId: t.external_item_id,
      naam: t.naam ?? '',
      adres: t.adres,
      mondayGroup: t.monday_group,
      rateKey: t.rate_key,
    })),
    evals: parsed.trainer_theme_evals.map((e) => ({
      trainerExternalId: e.trainer_ext,
      themaExternalId: e.thema_ext,
      avgOverallGrade: e.avg_overall_grade,
      evaluationCount: e.evaluation_count ?? 0,
    })),
  };
}

async function resolveTrainingId(admin: Admin, itemId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('trainings')
    .select('id')
    .eq('source_system', 'monday')
    .eq('external_item_id', itemId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    throw new Error(`resolveTrainingId: ${error.message}`);
  }
  return data?.id ?? null;
}

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
 * The full compute pipeline for a claimed run. Persists a `computed` run on
 * success (GEREED/GEEN MATCH) or marks the run FOUT with a failing stage on any
 * fail-closed condition. Delivery to Monday is a separate step.
 */
export async function runRecommendation(deps: ServiceDeps, run: ClaimedRun): Promise<RunOutcome> {
  const { admin, config } = deps;
  let stage = 'load_training';

  const fail = async (failingStage: string, detail: string | null = null): Promise<RunOutcome> => {
    await markRunFailed(admin, run.id, failingStage, detail);
    return { ok: false, resultStatus: 'FOUT', failingStage };
  };

  try {
    const live = await deps.reader.readTraining(run.monday_item_id);
    if (!live) {
      return fail('load_training');
    }

    stage = 'freshness';
    const trainingId = await resolveTrainingId(admin, run.monday_item_id);
    if (!trainingId) {
      return fail('stale_snapshot');
    }
    const inputs = await readInputs(admin, config.recommendableGroups);
    // Reject a missing or too-old snapshot — stale/manual trainer data must not
    // produce a valid-looking recommendation.
    if (
      !inputs.syncRunId ||
      !inputs.syncStartedAt ||
      Date.now() - Date.parse(inputs.syncStartedAt) > config.snapshotMaxAgeMs
    ) {
      return fail('stale_snapshot');
    }

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
    const eligible = filterEligible(live.themeExternalIds, inputs.trainers, effective);

    // With NO eligible trainer, GEEN MATCH is already definitive: there is nothing to
    // price, so the address LLM and the Routes calls are pure risk — a provider hiccup
    // there would turn a decided GEEN MATCH into a spurious FOUT. Skip both.
    const travelByTrainer = new Map<string, TrainerTravel | null>();
    let addr: AddressDecision | null = null;
    let excluded: Array<{ externalItemId: string; reason: string }> = [];
    let routes: InputArtifact['enrichment']['routes'] = [];
    let travelCacheHits = 0;

    if (eligible.length > 0) {
      stage = 'address';
      const decision = await deps.addressFormatter.format(live.locatie);
      if (decision.kind === 'error' || decision.kind === 'unresolved_location') {
        return fail('address', decision.detail);
      }
      addr = decision;

      stage = 'travel';
      if (decision.kind === 'no_travel_confirmed') {
        for (const t of eligible) {
          travelByTrainer.set(t.externalItemId, null);
        }
      } else {
        const resolved = await resolveTravel(deps.travelCache, deps.travelProvider, {
          destination: decision.formatted,
          hqAddress: config.hqAddress,
          trainers: eligible,
        });
        if (resolved.kind === 'fout') {
          return fail('travel', resolved.detail);
        }
        excluded = resolved.excluded;
        routes = resolved.routes;
        travelCacheHits = resolved.cacheHits;
        for (const t of eligible) {
          travelByTrainer.set(t.externalItemId, resolved.byTrainer.get(t.externalItemId) ?? null);
        }
      }
    }

    stage = 'pricing';
    const excludedIds = new Set(excluded.map((e) => e.externalItemId));
    const included = eligible.filter((t) => !excludedIds.has(t.externalItemId));
    // Duration/date were validated up front (any eligible trainer implies themes > 0,
    // which the validate_training stage already gated) so pricing input is sound here.
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
        computeScores(t.externalItemId, live.themeExternalIds, inputs.evals),
        ctx
      )
    );
    const ranked: RankedRecommendation[] = rankTrainers(computed);

    stage = 'persist';
    const artifact: InputArtifact = {
      version: 1,
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
        inputSyncRunId: inputs.syncRunId,
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

    await updateRunProvenance(admin, run.id, {
      trainingId,
      inputSyncRunId: inputs.syncRunId,
      mondayItemRevision: live.updatedAt,
      ackVersion: config.ackVersion,
      inputArtifact: artifact,
      inputArtifactHash: hashArtifact(artifact),
      addressDecision: addr,
      candidateCount: inputs.trainers.length,
      eligibleCount: eligible.length,
      excludedTrainers: excluded,
      providerErrors: null,
      travelCacheHits,
    });

    const result = await persistRecommendations(admin, run.id, trainingId, run.generation, ranked);
    if (result.superseded) {
      return { ok: false, resultStatus: null, superseded: true };
    }
    return { ok: true, resultStatus: ranked.length > 0 ? 'GEREED' : 'GEEN MATCH' };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_DETAIL
    );
    log.error('recommendation run failed', { runId: run.id, stage, detail });
    return fail(stage, detail);
  }
}
