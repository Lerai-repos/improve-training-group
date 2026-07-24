import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

import type { MondaySnapshotArtifact } from './artifact';

type Admin = SupabaseClient<Database>;

export interface ApplyOptions {
  /** Reuse an existing sync_runs row (created before preflight); else insert one. */
  runId?: string;
  target?: string | null;
  boardTotals?: Record<string, number | null>;
  anomalies?: unknown;
  /** Hash of the live schema inventory that produced this run (provenance). */
  schemaHash?: string;
  /** Hash of the reviewed config + acknowledgements file (provenance). */
  configHash?: string;
}

export interface ApplyResult {
  runId: string;
  counts: Record<string, number>;
}

/**
 * Apply a VALIDATED artifact via the atomic RPC. The RPC finalizes the run to
 * `ok` inside its own transaction; this only records a `failed` status if the
 * RPC (or the pre-checks) reject. Never call this with unvalidated data — the
 * caller must have run `validateSnapshot` first (see `planning.ts`/`sync-monday`).
 */
export async function applyArtifact(
  admin: Admin,
  artifact: MondaySnapshotArtifact,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  const p_artifact = JSON.parse(JSON.stringify(artifact));
  // Hash the artifact the SAME way the RPC will (pg md5(jsonb::text)), so the
  // stored hash binds the exact payload the RPC re-verifies before any write.
  const hashRes = await admin.rpc('jsonb_content_md5', { p: p_artifact });
  if (hashRes.error || !hashRes.data) {
    throw new Error(`content hash: ${hashRes.error?.message ?? 'null'}`);
  }
  const hash = hashRes.data;
  const anomaliesJson =
    opts.anomalies === undefined ? undefined : JSON.parse(JSON.stringify(opts.anomalies));
  const scopeJson = JSON.parse(JSON.stringify(artifact.scope));

  let runId = opts.runId;
  if (runId) {
    const upd = await admin
      .from('sync_runs')
      .update({
        artifact_counts: artifact.counts,
        artifact_hash: hash,
        schema_hash: opts.schemaHash,
        config_hash: opts.configHash,
        board_totals: opts.boardTotals,
        anomalies: anomaliesJson,
      })
      .eq('id', runId);
    if (upd.error) {
      throw new Error(`sync_runs update: ${upd.error.message}`);
    }
  } else {
    const run = await admin
      .from('sync_runs')
      .insert({
        mode: 'apply',
        scope: scopeJson,
        target: opts.target,
        artifact_counts: artifact.counts,
        artifact_hash: hash,
        schema_hash: opts.schemaHash,
        config_hash: opts.configHash,
        board_totals: opts.boardTotals,
        anomalies: anomaliesJson,
      })
      .select('id')
      .single();
    if (run.error) {
      throw new Error(`sync_runs insert: ${run.error.message}`);
    }
    runId = run.data.id;
  }

  const { error } = await admin.rpc('apply_monday_snapshot', { p_run_id: runId, p_artifact });
  if (error) {
    // Only mark failed if still running — the RPC commits + sets 'ok' in-transaction,
    // so a lost response must not overwrite a genuinely committed run.
    const upd = await admin
      .from('sync_runs')
      .update({ status: 'failed', failing_stage: 'apply', finished_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('status', 'running');
    if (upd.error) {
      throw new Error(
        `apply failed (${error.message}); ALSO failed to record it: ${upd.error.message}`
      );
    }
    throw new Error(`apply_monday_snapshot: ${error.message}`);
  }
  // The RPC set status='ok'/finished_at in-transaction.
  return { runId, counts: artifact.counts };
}
