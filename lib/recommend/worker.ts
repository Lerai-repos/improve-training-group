import { deliverRun, type StatusWriter } from './delivery';
import { runRecommendation, type ClaimedRun, type ServiceDeps } from './service';

/**
 * The durable worker. Claims a queued run via a lease (the RPC also reclaims a
 * stuck 'running' run whose lease expired), computes + persists it, then delivers.
 * `redeliverPending` re-attempts the Monday write for runs that computed/failed but
 * whose status hasn't reached Monday yet — the convergence retry path.
 */

export interface WorkerDeps extends ServiceDeps {
  statusWriter: StatusWriter;
  owner: string;
}

// The claim lease MUST outlive the route's `maxDuration` (300s) ceiling: a worker
// is force-terminated at that ceiling, so if the lease outlives it no *live* worker
// can ever have an expired lease. Only a genuinely dead worker's run is reclaimed
// (after the lease expires), which is why the compute writes don't need per-write
// owner fencing — two live workers can never hold the same run.
const CLAIM_LEASE_SECONDS = 450;
const DELIVERY_LEASE_SECONDS = 60;
const DEFAULT_MAX = 25;

async function claimRun(deps: WorkerDeps): Promise<ClaimedRun | null> {
  const { data, error } = await deps.admin.rpc('claim_recommendation_run', {
    p_owner: deps.owner,
    p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (error) {
    throw new Error(`claim_recommendation_run: ${error.message}`);
  }
  const row = data?.[0];
  if (!row) {
    return null;
  }
  return { id: row.id, monday_item_id: row.monday_item_id, generation: row.generation };
}

// A generation can be superseded *while* we are writing to Monday; finalize_delivery
// detects that post-write and hands back the newer run as `repair_run_id`. Following
// it immediately is what makes convergence prompt instead of waiting for the next
// cron scan (up to 5 minutes of stale status on the board). Each hop moves to a
// strictly greater generation, so the chain terminates; the cap is a backstop.
const MAX_REPAIR_HOPS = 3;

/**
 * Deliver a run, then follow any repair signal — the newer generation that became
 * deliverable during the write. Without this the signal is computed per delivery and
 * dropped, reopening the staleness window it exists to close.
 */
export async function deliverWithRepair(deps: WorkerDeps, runId: string): Promise<boolean> {
  let next: string | null = runId;
  let delivered = false;
  const seen = new Set<string>();

  for (let hop = 0; next !== null && hop < MAX_REPAIR_HOPS; hop += 1) {
    if (seen.has(next)) {
      break; // defensive: never revisit a run in one chain
    }
    seen.add(next);
    const res = await deliverRun(
      deps.admin,
      deps.statusWriter,
      next,
      deps.owner,
      DELIVERY_LEASE_SECONDS
    );
    delivered = delivered || res.delivered;
    next = res.repairRunId;
  }
  return delivered;
}

/** Claim one run (if any), compute+persist it, and deliver. Returns false when idle. */
export async function drainOnce(deps: WorkerDeps): Promise<boolean> {
  const claimed = await claimRun(deps);
  if (!claimed) {
    return false;
  }
  await runRecommendation(deps, claimed);
  await deliverWithRepair(deps, claimed.id);
  return true;
}

/** Drain up to `max` queued runs, stopping early once `shouldContinue` is false
 * (e.g. a wall-clock deadline) so a slow provider-backed job can't starve the rest. */
export async function drain(
  deps: WorkerDeps,
  max: number = DEFAULT_MAX,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let processed = 0;
  while (processed < max && shouldContinue() && (await drainOnce(deps))) {
    processed += 1;
  }
  return processed;
}

/** Re-attempt delivery for computed/failed runs not yet on Monday (convergence).
 * Stops early once `shouldContinue` is false so it stays within the cron budget. */
export async function redeliverPending(
  deps: WorkerDeps,
  max: number = DEFAULT_MAX,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  const { data, error } = await deps.admin
    .from('recommendation_runs')
    .select('id')
    .in('status', ['computed', 'failed'])
    .or('writeback_status.is.null,writeback_status.neq.delivered')
    .order('created_at', { ascending: true })
    .limit(max);
  if (error) {
    throw new Error(`redeliverPending: ${error.message}`);
  }
  let delivered = 0;
  for (const row of data ?? []) {
    if (!shouldContinue()) {
      break;
    }
    if (await deliverWithRepair(deps, row.id)) {
      delivered += 1;
    }
  }
  return delivered;
}
