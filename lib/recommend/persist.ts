import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

import { jsonBool, jsonNumber, toJson } from './json';
import type { InputArtifact } from './artifact';
import type { AddressDecision } from './address';
import type { RankedRecommendation } from './types';

type Admin = SupabaseClient<Database>;

export interface PersistResult {
  superseded: boolean;
  count: number;
}

/** Map a ranked recommendation to the `apply_recommendations` row shape. */
function toRecRow(r: RankedRecommendation): Record<string, unknown> {
  return {
    trainer_ext: r.externalItemId,
    rank: r.rank,
    billable_hours: r.billableHours,
    hourly_rate_cents: r.hourlyRateCents,
    training_fee_cents: r.trainingFeeCents,
    trainer_travel_cost_cents: r.trainerTravelCostCents,
    client_travel_charge_cents: r.clientTravelChargeCents,
    travel_time_compensation_cents: r.travelTimeCompensationCents,
    total_cost_cents: r.totalCostCents,
    round_trip_distance_km: r.roundTripDistanceKm,
    hq_round_trip_distance_km: r.hqRoundTripDistanceKm,
    round_trip_duration_minutes: r.roundTripDurationMinutes,
    theme_avg_score: r.themeAvgScore,
    overall_avg_score: r.overallAvgScore,
    calculate_travel: r.calculateTravel,
  };
}

/** Call the atomic apply RPC (generation CAS → append → finalize `computed`). */
export async function persistRecommendations(
  admin: Admin,
  runId: string,
  trainingId: string,
  generation: number,
  ranked: readonly RankedRecommendation[]
): Promise<PersistResult> {
  const { data, error } = await admin.rpc('apply_recommendations', {
    p_run_id: runId,
    p_training_id: trainingId,
    p_generation: generation,
    p_recs: toJson(ranked.map(toRecRow)),
  });
  if (error) {
    throw new Error(`apply_recommendations: ${error.message}`);
  }
  return { superseded: jsonBool(data, 'superseded'), count: jsonNumber(data, 'count') ?? 0 };
}

/** Provenance written on the run before apply (all reproducibility fields). */
export interface RunProvenance {
  trainingId: string;
  inputSyncRunId: string | null;
  mondayItemRevision: string | null;
  ackVersion: string | null;
  inputArtifact: InputArtifact;
  inputArtifactHash: string;
  /** null when the address was never evaluated (no eligible trainer → short-circuit). */
  addressDecision: AddressDecision | null;
  candidateCount: number;
  eligibleCount: number;
  excludedTrainers: Array<{ externalItemId: string; reason: string }>;
  providerErrors: unknown;
  travelCacheHits: number;
}

export async function updateRunProvenance(
  admin: Admin,
  runId: string,
  prov: RunProvenance
): Promise<void> {
  const { error } = await admin
    .from('recommendation_runs')
    .update({
      training_id: prov.trainingId,
      input_sync_run_id: prov.inputSyncRunId,
      monday_item_revision: prov.mondayItemRevision,
      ack_version: prov.ackVersion,
      input_artifact: toJson(prov.inputArtifact),
      input_artifact_hash: prov.inputArtifactHash,
      address_decision: toJson(prov.addressDecision),
      candidate_count: prov.candidateCount,
      eligible_count: prov.eligibleCount,
      excluded_trainers: toJson(prov.excludedTrainers),
      provider_errors: toJson(prov.providerErrors),
      travel_cache_hits: prov.travelCacheHits,
    })
    .eq('id', runId);
  if (error) {
    throw new Error(`updateRunProvenance: ${error.message}`);
  }
}

/** Mark a still-running run as failed (FOUT) so delivery writes the FOUT status.
 * An optional sanitized `detail` (e.g. a caught exception message) is persisted to
 * `provider_errors` for post-hoc diagnosis — the stage alone loses the real cause. */
export async function markRunFailed(
  admin: Admin,
  runId: string,
  failingStage: string,
  detail: string | null = null
): Promise<void> {
  const base = {
    status: 'failed',
    result_status: 'FOUT',
    failing_stage: failingStage,
    finished_at: new Date().toISOString(),
  };
  const patch =
    detail === null ? base : { ...base, provider_errors: toJson({ stage: failingStage, detail }) };
  const { error } = await admin
    .from('recommendation_runs')
    .update(patch)
    .eq('id', runId)
    .eq('status', 'running');
  if (error) {
    throw new Error(`markRunFailed: ${error.message}`);
  }
}
