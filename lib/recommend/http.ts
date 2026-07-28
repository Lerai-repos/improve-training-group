import { currentDeadlineMs } from './deadline';

/**
 * `fetch` with bounded exponential-backoff retry for TRANSIENT failures — network
 * errors and retryable status codes (429 + 5xx). A single blip (timeout, rate
 * limit, temporary 5xx) would otherwise become a persisted terminal FOUT, since
 * the cron retries delivery but never recomputation. Non-retryable responses (e.g.
 * 4xx auth errors) return immediately; the caller decides what a non-2xx means.
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
// Per-attempt ceiling: a hung connection must abort so the loop advances and the
// run reaches a diagnosable FOUT. 3 × 15s + backoff stays comfortably under the
// route's 300s maxDuration even with two providers in one invocation.
const DEFAULT_TIMEOUT_MS = 15000;
const BACKOFF_BASE = 2;
const TOO_MANY_REQUESTS = 429;
// A provider's Retry-After is honored but capped, so an over-long window can't blow
// the route budget (it just retries at the cap, then FOUTs if still limited).
const MAX_RETRY_AFTER_MS = 30000;
const SECONDS_TO_MS = 1000;
const RETRYABLE_STATUS = new Set([TOO_MANY_REQUESTS, 500, 502, 503, 504]);

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP date) to ms, or null. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * SECONDS_TO_MS;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return null;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: RetryOptions
): Promise<Response> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isLast = attempt === attempts - 1;
    // Honor a run-scoped absolute deadline: no time left → fail fast so the caller
    // can finalize (FOUT) before the route is killed. Cap this attempt's timeout to
    // whatever remains.
    const deadlineMs = currentDeadlineMs();
    const remaining = deadlineMs === null ? Number.POSITIVE_INFINITY : deadlineMs - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new Error('fetchWithRetry: run deadline exceeded');
    }
    let nextDelayMs = baseDelayMs * BACKOFF_BASE ** attempt;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.min(timeoutMs, remaining)
    );
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // Read the body WHILE the timeout is still armed — fetch resolves on headers,
      // so a server that stalls the body would otherwise hang past the deadline.
      // Re-wrap the buffered body so callers keep using .json()/.text()/.ok/.status.
      const body = await res.text();
      const buffered = new Response(body.length > 0 ? body : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      if (isLast || !RETRYABLE_STATUS.has(res.status)) {
        return buffered;
      }
      // Retryable, not the last attempt → prefer a valid Retry-After on a 429
      // (capped), else exponential backoff.
      const retryAfter =
        res.status === TOO_MANY_REQUESTS ? parseRetryAfter(res.headers.get('retry-after')) : null;
      nextDelayMs =
        retryAfter !== null
          ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
          : baseDelayMs * BACKOFF_BASE ** attempt;
    } catch (error) {
      lastError = error;
      if (isLast) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    // Never sleep past the deadline; the next iteration's check then fails fast.
    const remainingForDelay =
      deadlineMs === null ? nextDelayMs : Math.max(0, deadlineMs - Date.now());
    await delay(Math.min(nextDelayMs, remainingForDelay));
  }

  // Unreachable: the last iteration always returns or throws.
  throw lastError ?? new Error('fetchWithRetry: retries exhausted');
}
