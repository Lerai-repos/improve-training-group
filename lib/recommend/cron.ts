import { runWithDeadline } from './deadline';
import { drain, redeliverPending, type WorkerDeps } from './worker';

/**
 * The cron drain, secured by `CRON_SECRET` so the service-role worker can't be
 * driven by anyone (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 *
 * Under backlog:
 *   - convergence (redelivering already-computed writebacks — cheap Monday status
 *     writes) runs FIRST so the queue drain can't starve it; it runs until the deadline.
 *   - the whole drain runs under an ABSOLUTE deadline (`runWithDeadline`) that bounds
 *     every provider retry, so a compute job claimed late (or one whose calls keep
 *     timing out) fails fast and FINALIZES (FOUT) before the 300s kill instead of being
 *     left 'running' and repeatedly reclaimed. The per-job reserve is a secondary
 *     optimization — don't START a job we'd only immediately truncate.
 * The deadline (270s) leaves ~30s under maxDuration to persist FOUT + finalize.
 */

// Absolute deadline for provider retries; 30s under the 300s maxDuration for finalize.
const DEFAULT_BUDGET_MS = 270_000;
// Don't START a compute job without at least this much left (it would just truncate).
const DEFAULT_JOB_RESERVE_MS = 120_000;

/**
 * Constant-shape bearer check for the self-authenticating `/api` routes (middleware
 * auth excludes `/api`). An unset/empty secret NEVER authorizes — a missing env var
 * must not silently open the endpoint.
 */
export function authorizeBearer(authHeader: string | null, secret: string | undefined): boolean {
  return typeof secret === 'string' && secret.length > 0 && authHeader === `Bearer ${secret}`;
}

export function authorizeCron(authHeader: string | null, secret: string | undefined): boolean {
  return authorizeBearer(authHeader, secret);
}

export async function runCronDrain(
  deps: WorkerDeps,
  opts?: { nowMs?: () => number; budgetMs?: number; jobReserveMs?: number }
): Promise<{ processed: number; redelivered: number }> {
  const nowMs = opts?.nowMs ?? Date.now;
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const jobReserveMs = opts?.jobReserveMs ?? DEFAULT_JOB_RESERVE_MS;
  const deadline = nowMs() + budgetMs;

  return runWithDeadline(deadline, async () => {
    // Writebacks are short (one status write) → run them right up to the deadline.
    const redelivered = await redeliverPending(deps, undefined, () => nowMs() < deadline);
    // Only claim a compute job with a full job budget left; the deadline bounds it regardless.
    const processed = await drain(deps, undefined, () => nowMs() + jobReserveMs <= deadline);
    return { processed, redelivered };
  });
}
