/* eslint-disable no-console */
// The fixture's fingerprints were recomputed under this key by sanitize-replay.ts.
// It MUST be set before anything imports address-key.ts, which resolves and caches
// the key on first use.
process.env.ADDRESS_HASH_KEY = 'replay-fixture-address-hash-key-v1';

import { EMPTY_ACK } from '@lib/monday';
import { canonicalJson } from '@lib/recommend/artifact';
import {
  createMemoryTravelCacheStore,
  createTravelCache,
  runRecommendation,
  type EngineConfig,
  type LiveMondayReader,
  type LiveTraining,
  type RecommendationResult,
  type ServiceDeps,
} from '@lib/recommend';
import type { AddressDecision } from '@lib/recommend/address';
import type { RouteElement } from '@lib/recommend/travel';
import type { CandidateTrainer, QualObservation } from '@lib/recommend/types';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_OVERRIDE } from '@lib/trainers/uurtarief';

/**
 * THE equivalence proof for the Supabase strip: replay each recorded training
 * through the rewritten engine and diff the WHOLE result against what the old,
 * database-backed engine produced on exactly the same inputs.
 *
 * Every input is pinned — training, qualifications, roster, config, rate cards, and
 * both providers' responses — so any difference is a real behaviour change, not
 * drift in Monday.
 *
 * Three fields are normalized out because we changed them ON PURPOSE:
 *   - the artifact `version` (2 → 3),
 *   - the trainer identity field (internal uuid → Monday item id),
 *   - the artifact hash, which is derived from both.
 * Everything else, address fingerprints included, must match exactly.
 *
 *   pnpm replay:verify
 */

const DIR = join(process.cwd(), 'fixtures', 'replay');

interface Recorded {
  training: LiveTraining | null;
  qualifications: QualObservation[];
  addressCalls: Array<{ raw: string | null; decision: AddressDecision }>;
  routingKey: string;
  travelCalls: Array<{ origins: string[]; destination: string; elements: RouteElement[] }>;
}

const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

/** A provider that replays recorded responses and refuses anything unrecorded. */
function replayTravel(rec: Recorded) {
  const byKey = new Map<string, RouteElement[]>();
  for (const call of rec.travelCalls) {
    byKey.set(`${call.origins.join('|')}→${call.destination}`, call.elements);
  }
  return {
    routingKey: () => rec.routingKey,
    distances: (origins: readonly string[], destination: string): Promise<RouteElement[]> => {
      const hit = byKey.get(`${origins.join('|')}→${destination}`);
      if (!hit) {
        // Fail loudly: silently inventing a response would let a changed call
        // pattern pass the equivalence check.
        return Promise.reject(
          new Error(`replay: no recorded route for ${origins.length} origin(s) → ${destination}`)
        );
      }
      return Promise.resolve(hit);
    },
  };
}

/**
 * Sort the audit collections whose order is not contractual. The old artifact came
 * back from Postgres `jsonb`, which does not preserve key order and need not
 * preserve array order either, so comparing raw serializations reports noise.
 * `ranked` is deliberately NOT sorted — its order IS the answer.
 */
function sortAuditArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value.map(sortAuditArrays)].sort((a, b) =>
      canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sortAuditArrays(v)]));
  }
  return value;
}

/**
 * Strip only what we changed ON PURPOSE, then compare everything else. Listing the
 * intentional differences here (rather than listing the fields to compare) means a
 * change to anything NOT named below fails the check instead of slipping past.
 */
function stripIntentional(artifact: Record<string, unknown>): unknown {
  const trainers = Array.isArray(artifact.trainers) ? artifact.trainers : [];
  const rates = (artifact.rates ?? {}) as Record<string, unknown>;
  const rateCards = Array.isArray(rates.rateCards) ? rates.rateCards : [];
  const enrichment = (artifact.enrichment ?? {}) as Record<string, unknown>;
  return {
    ...artifact,
    enrichment: {
      ...enrichment,
      /**
       * The address prompt gained a `city` field, so its version moved v1 → v2. The
       * classification itself is unchanged — the baselines' own decisions are replayed
       * from the fixtures, so any real drift would still show up in `addressDecision`.
       *
       * Pinned as a PAIR, not stripped as a field: a future v3 is not normalised and
       * fails, which is the whole point of listing intentional differences rather than
       * listing what to compare. Applied to both sides, so a recorded v1 stays v1 and
       * only the live v2 folds onto it.
       */
      promptVersion: enrichment.promptVersion === 'v2' ? 'v1' : enrichment.promptVersion,
    },
    // v2 → v3, deliberate.
    version: undefined,
    // Trainer identity moved from the internal uuid to the Monday item id; the old
    // artifact carried BOTH, the new one only the item id.
    trainers: trainers.map((t) => {
      const row = (t ?? {}) as Record<string, unknown>;
      return { ...row, id: undefined };
    }),
    rates: {
      ...rates,
      // There is no sync to point at any more.
      inputSyncRunId: undefined,
      // rate_cards.trainerId is now a Monday item id; every card here is a cohort
      // default (trainerId null), so only the field's MEANING changed, not a value.
      rateCards: rateCards.map((c) => {
        const row = (c ?? {}) as Record<string, unknown>;
        return { ...row, trainerId: row.trainerId === null ? null : undefined };
      }),
    },
  };
}

function normalize(result: RecommendationResult): unknown {
  if (!result.ok) {
    return {
      resultStatus: 'FOUT',
      stage: result.failure.stage,
      message: result.failure.message,
    };
  }
  return {
    resultStatus: result.resultStatus,
    counts: result.counts,
    excluded: [...result.excluded].sort((a, b) => a.externalItemId.localeCompare(b.externalItemId)),
    // The FULL decision, not just its kind.
    addressDecision: result.addressDecision,
    mondayItemRevision: result.mondayItemRevision,
    travelCacheHits: result.travelCacheHits,
    providerErrors: result.providerErrors,
    ranked: result.recommendations,
    // The whole artifact — qualifications, effective values, trainer inputs, rates,
    // enrichment metadata and routes all included.
    artifact: sortAuditArrays(
      stripIntentional(result.artifact as unknown as Record<string, unknown>)
    ),
  };
}

interface ExpectedRow {
  rank: number;
  billable_hours: number;
  hourly_rate_cents: number;
  training_fee_cents: number;
  trainer_travel_cost_cents: number;
  client_travel_charge_cents: number;
  travel_time_compensation_cents: number;
  total_cost_cents: number;
  round_trip_distance_km: number;
  hq_round_trip_distance_km: number;
  round_trip_duration_minutes: number;
  calculate_travel: boolean;
  theme_avg_score: number | null;
  overall_avg_score: number;
  trainers: { external_item_id: string } | null;
}

function normalizeExpected(doc: {
  expected: {
    run: Record<string, unknown> & {
      input_artifact: Record<string, unknown>;
    };
    recommendations: ExpectedRow[];
  };
}): unknown {
  const run = doc.expected.run;
  if (run.result_status === 'FOUT') {
    return {
      resultStatus: 'FOUT',
      stage: run.failing_stage,
      message: null,
    };
  }
  const excluded = Array.isArray(run.excluded_trainers) ? run.excluded_trainers : [];
  return {
    resultStatus: run.result_status,
    counts: {
      candidate: run.candidate_count,
      eligible: run.eligible_count,
      recommended: run.recommendation_count,
    },
    excluded: [...excluded].sort((a, b) =>
      String(a.externalItemId).localeCompare(String(b.externalItemId))
    ),
    addressDecision: run.address_decision,
    mondayItemRevision: run.monday_item_revision,
    travelCacheHits: run.travel_cache_hits,
    providerErrors: run.provider_errors,
    ranked: doc.expected.recommendations.map((r) => ({
      externalItemId: r.trainers?.external_item_id ?? '?',
      rank: r.rank,
      billableHours: r.billable_hours,
      hourlyRateCents: r.hourly_rate_cents,
      trainingFeeCents: r.training_fee_cents,
      trainerTravelCostCents: r.trainer_travel_cost_cents,
      clientTravelChargeCents: r.client_travel_charge_cents,
      travelTimeCompensationCents: r.travel_time_compensation_cents,
      totalCostCents: r.total_cost_cents,
      roundTripDistanceKm: r.round_trip_distance_km,
      hqRoundTripDistanceKm: r.hq_round_trip_distance_km,
      roundTripDurationMinutes: r.round_trip_duration_minutes,
      calculateTravel: r.calculate_travel,
      themeAvgScore: r.theme_avg_score,
      overallAvgScore: r.overall_avg_score,
    })),
    artifact: sortAuditArrays(stripIntentional(run.input_artifact)),
  };
}

async function main(): Promise<void> {
  const shared = read('_shared.json') as {
    config: EngineConfig;
    inputs: { trainers: Array<Record<string, string | null>> };
    rateCards: Array<Record<string, string | number | null>>;
  };
  const roster: CandidateTrainer[] = shared.inputs.trainers.map((t) => ({
    externalItemId: String(t.external_item_id),
    naam: String(t.naam ?? ''),
    adres: t.adres === null ? null : String(t.adres),
    mondayGroup: t.monday_group === null ? null : String(t.monday_group),
    rateKey: t.rate_key === null ? null : String(t.rate_key),
    /**
     * Always absent, and that is the point of the replay.
     *
     * Every recorded fixture predates the `Uurtarief` column, so their expected outputs
     * were computed from the cohort rate alone. Seeding anything else here would make the
     * comparison test the override instead of the regression it exists to catch.
     */
    rateOverride: NO_OVERRIDE,
  }));
  const config: EngineConfig = {
    ...shared.config,
    rateCards: shared.rateCards.map((c) => ({
      rateKey: String(c.rate_key),
      trainerId: c.trainer_id === null ? null : String(c.trainer_id),
      validFrom: String(c.valid_from),
      validUntil: c.valid_until === null ? null : String(c.valid_until),
      hourlyRateCents: Number(c.hourly_rate_cents),
    })),
  };

  const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  let failures = 0;

  for (const file of files) {
    const doc = read(file) as { itemId: string; recorded: Recorded; expected: never };
    const rec = doc.recorded;
    const reader: LiveMondayReader = {
      readTraining: () => Promise.resolve(rec.training),
      readThemeQualifications: () => Promise.resolve(rec.qualifications),
    };
    const deps: ServiceDeps = {
      reader,
      roster,
    /**
     * Empty, deliberately. The baselines were recorded when evaluations were inert, so
     * `scores[]` and every ranked row hold `(null, 0)`; feeding live statistics here
     * would make this check fail every night for a reason that is not a regression.
     * The fixtures are NOT regenerated — that would hide a real engine change behind
     * this one.
     */
    evaluations: null,
      addressFormatter: {
        format: () =>
          Promise.resolve(
            rec.addressCalls[0]?.decision ?? { kind: 'error', detail: 'no recorded address call' }
          ),
      },
      travelProvider: replayTravel(rec),
      // Empty per training, exactly as when recorded — so travelCacheHits matches.
      travelCache: createTravelCache(createMemoryTravelCacheStore()),
      ack: EMPTY_ACK,
      config,
    };

    const actual = normalize(await runRecommendation(deps, doc.itemId));
    const expected = normalizeExpected(doc as never);
    // canonicalJson sorts keys recursively, so key ORDER differences (jsonb round-trip)
    // cannot masquerade as behaviour changes.
    const a = JSON.stringify(JSON.parse(canonicalJson(actual)), null, 1);
    const e = JSON.stringify(JSON.parse(canonicalJson(expected)), null, 1);
    if (a === e) {
      console.log(`  ${doc.itemId}  MATCH`);
    } else {
      failures += 1;
      console.error(`  ${doc.itemId}  DIFF`);
      const al = a.split('\n');
      const el = e.split('\n');
      for (let i = 0; i < Math.max(al.length, el.length); i += 1) {
        if (al[i] !== el[i]) {
          console.error(`    line ${i}\n      expected: ${el[i]}\n      actual:   ${al[i]}`);
        }
      }
    }
  }

  console.log(
    `\n${files.length - failures}/${files.length} trainings match the recorded baseline.`
  );
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('replay-verify failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
