import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A run-scoped ABSOLUTE wall-clock deadline (ms epoch). `fetchWithRetry` reads it to
 * truncate its retries so a single run's provider calls (address + HQ + trainer
 * routes, each a bounded-retry fetch) can't collectively outlast the route's
 * maxDuration — the run instead fails fast and finalizes (FOUT) before Vercel kills
 * the function. Ambient context avoids threading a signal through every provider
 * interface (Completion / RoutesTransport / AddressFormatter / TravelProvider).
 */

const store = new AsyncLocalStorage<number>();

/** Run `fn` with an absolute deadline (ms epoch) that bounds provider retries within it. */
export function runWithDeadline<T>(deadlineMs: number, fn: () => Promise<T>): Promise<T> {
  return store.run(deadlineMs, fn);
}

/** The current ambient deadline (ms epoch), or null outside any {@link runWithDeadline}. */
export function currentDeadlineMs(): number | null {
  return store.getStore() ?? null;
}
