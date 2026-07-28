import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

import { jsonBool, jsonString } from './json';

type Admin = SupabaseClient<Database>;

export type StatusLabel = 'GEREED' | 'GEEN MATCH' | 'FOUT';

/** The scoped Monday writer — the ONLY thing that writes to Monday. */
export interface StatusWriter {
  writeStatus(itemId: string, label: StatusLabel): Promise<void>;
}

export interface DeliverResult {
  delivered: boolean;
  reason: string | null;
  /** A newer run that now needs (re)delivery — the convergence repair signal. */
  repairRunId: string | null;
}

function isStatusLabel(v: string | null): v is StatusLabel {
  return v === 'GEREED' || v === 'GEEN MATCH' || v === 'FOUT';
}

/**
 * Deliver a run's status to Monday under the per-training delivery lease + fencing.
 * Acquire → (if not latest generation, the RPC marks it superseded and we skip the
 * write) → write the status → finalize (records outcome, releases the lease, and
 * returns a repair run id if a newer generation now needs delivery).
 */
export async function deliverRun(
  admin: Admin,
  writer: StatusWriter,
  runId: string,
  owner: string,
  leaseSeconds: number
): Promise<DeliverResult> {
  const lease = await admin.rpc('acquire_delivery_lease', {
    p_run_id: runId,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  });
  if (lease.error) {
    throw new Error(`acquire_delivery_lease: ${lease.error.message}`);
  }
  if (!jsonBool(lease.data, 'acquired')) {
    return { delivered: false, reason: jsonString(lease.data, 'reason'), repairRunId: null };
  }

  const { data: run, error: readErr } = await admin
    .from('recommendation_runs')
    .select('monday_item_id, result_status')
    .eq('id', runId)
    .single();
  if (readErr) {
    throw new Error(`deliverRun read: ${readErr.message}`);
  }

  if (!isStatusLabel(run.result_status)) {
    const fin = await admin.rpc('finalize_delivery', {
      p_run_id: runId,
      p_owner: owner,
      p_success: false,
      p_error: 'no result_status to deliver',
    });
    if (fin.error) {
      throw new Error(`finalize_delivery: ${fin.error.message}`);
    }
    return {
      delivered: false,
      reason: 'no result_status',
      repairRunId: jsonString(fin.data, 'repair_run_id'),
    };
  }

  let success = true;
  let errorDetail = '';
  try {
    await writer.writeStatus(run.monday_item_id, run.result_status);
  } catch (e) {
    success = false;
    errorDetail = e instanceof Error ? e.message : String(e);
  }

  const fin = await admin.rpc('finalize_delivery', {
    p_run_id: runId,
    p_owner: owner,
    p_success: success,
    p_error: errorDetail,
  });
  if (fin.error) {
    throw new Error(`finalize_delivery: ${fin.error.message}`);
  }
  // A stale_owner finalize updated NOTHING (the lease was taken over) — the writeback
  // is still pending, so this delivery did not complete. Don't report it delivered.
  const staleOwner = jsonBool(fin.data, 'stale_owner');
  return {
    delivered: success && !staleOwner,
    reason: staleOwner ? 'stale_owner' : null,
    repairRunId: jsonString(fin.data, 'repair_run_id'),
  };
}

/** Record what a status write did, for tests. */
export function createRecordingStatusWriter(): StatusWriter & {
  writes: Array<{ itemId: string; label: StatusLabel }>;
} {
  const writes: Array<{ itemId: string; label: StatusLabel }> = [];
  return {
    writes,
    writeStatus(itemId: string, label: StatusLabel): Promise<void> {
      writes.push({ itemId, label });
      return Promise.resolve();
    },
  };
}
