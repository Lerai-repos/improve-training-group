import { z } from 'zod';

import { buildAgendaScan, type AgendaScan, type AssignmentRow } from './assignments';
import type { KvStore } from './kv';

/**
 * The workload index, shared and short-lived.
 *
 * Workload is read on every view open, and the view polls every 20 seconds — so without
 * a cache a handful of planners with tabs open would scan the whole Agenda board
 * continuously against a 25.000/day Monday budget. With one, the board is read at most
 * once per TTL no matter how many people are looking.
 *
 * **Single-flight.** A plain cache is not enough: when it expires, every in-flight
 * request misses at the same moment and they all scan the board together — the stampede
 * the cache existed to prevent, concentrated into one second. One request takes a lock
 * and refreshes; the rest wait briefly for its result.
 *
 * **Failure is never zero.** `readAssignmentIndex` fails closed on malformed Monday data,
 * and that failure travels: this throws too, and the caller renders the columns as `—`.
 * A cached empty index would be indistinguishable from "nobody is busy".
 */

/** Five minutes: workload changes when someone is booked, which is not a per-second event. */
export const ASSIGNMENTS_TTL_MS = 5 * 60 * 1000;

/** Long enough for a board scan, short enough that a crashed holder unblocks quickly. */
const LOCK_TTL_MS = 30_000;

/**
 * How long a failure is remembered.
 *
 * Without this, a rejected scan leaves nothing behind and the next poll — 20 seconds
 * later, from every open tab — starts the same doomed scan again. During a Monday outage
 * that is a steady drain on the API budget AND a six-second delay on every view open, for
 * two columns nobody can see anyway. Short, because recovery should be quick once Monday
 * is back.
 */
const FAILURE_TTL_MS = 30_000;

/** Distinct from a cached scan: this is "we tried and could not", never an empty index. */
const UNAVAILABLE = '"unavailable"';
const WAIT_STEP_MS = 250;
const MAX_WAIT_STEPS = 12;

const cachedSchema = z.object({
  workload: z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.number()]))])),
  /**
   * The month is NULLABLE, because `monthByItemId` records undated trainings as `null`
   * on purpose. Requiring a string here would make one undated item on the board reject
   * the entire cache entry on every read — a permanent miss that rescans Monday every
   * time and leaves concurrent waiters showing `—` after a perfectly good refresh.
   */
  months: z.array(z.tuple([z.string(), z.string().nullable()])),
});

function encode(scan: AgendaScan): string {
  return JSON.stringify({
    workload: [...scan.workload].map(([trainer, months]) => [trainer, [...months]]),
    months: [...scan.monthByItemId],
  });
}

function decode(raw: string | null): AgendaScan | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = cachedSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return {
    workload: new Map(result.data.workload.map(([trainer, months]) => [trainer, new Map(months)])),
    monthByItemId: new Map(result.data.months),
  };
}

export interface CachedAssignments {
  /** The current scan. Throws when it cannot be determined — never returns an empty one. */
  read(): Promise<AgendaScan>;
}

export interface CachedAssignmentsDeps {
  kv: KvStore;
  /** The board scan. Fails closed on malformed data, and that failure is propagated. */
  load: () => Promise<AgendaScan>;
  boardId: string;
  ttlMs?: number;
  /** Injected in tests so waiting for the lock holder costs no real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; production mints a random owner token per refresh. */
  token?: () => string;
}

export function createCachedAssignments(deps: CachedAssignmentsDeps): CachedAssignments {
  const ttlMs = deps.ttlMs ?? ASSIGNMENTS_TTL_MS;
  const key = `assignments:${deps.boardId}`;
  const lockKey = `assignments-lock:${deps.boardId}`;
  const mintToken = deps.token ?? (() => globalThis.crypto.randomUUID());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    async read() {
      const raw = await deps.kv.get(key);
      if (raw === UNAVAILABLE) {
        // A recent scan failed. Degrade immediately rather than re-running it.
        throw new Error('Workload index unavailable: a recent refresh failed');
      }
      const cached = decode(raw);
      if (cached !== null) {
        return cached;
      }

      const token = mintToken();
      const mine = await deps.kv.setIfAbsent(lockKey, token, { ttlMs: LOCK_TTL_MS });
      if (mine) {
        try {
          const scan = await deps.load();
          await deps.kv.set(key, encode(scan), { ttlMs });
          return scan;
        } catch (error) {
          // Remember the failure, briefly. Never as an empty index — that would read as
          // "nobody is busy" for the whole TTL.
          await deps.kv.set(key, UNAVAILABLE, { ttlMs: FAILURE_TTL_MS });
          throw error;
        } finally {
          /**
           * Release only OUR lock.
           *
           * A scan that outlives the 30s lease lets someone else acquire a fresh lock;
           * deleting unconditionally would free theirs and re-open the stampede this
           * exists to prevent. Read-then-delete narrows that to a window of microseconds
           * rather than closing it — the lock is a stampede guard, not a correctness
           * mechanism, so a cheap check is the right weight of solution.
           */
          if ((await deps.kv.get(lockKey)) === token) {
            await deps.kv.del(lockKey);
          }
        }
      }

      // Someone else is scanning. Wait for their result rather than starting a second
      // scan of the same board.
      for (let step = 0; step < MAX_WAIT_STEPS; step += 1) {
        await sleep(WAIT_STEP_MS);
        const latest = await deps.kv.get(key);
        // The holder may have failed fast. Recognise that here too, or every waiter
        // spends the full three seconds polling for an answer that already exists.
        if (latest === UNAVAILABLE) {
          throw new Error('Workload index unavailable: the refresh in front of us failed');
        }
        const fresh = decode(latest);
        if (fresh !== null) {
          return fresh;
        }
      }

      throw new Error('Workload index unavailable: the refresh in front of us did not finish');
    },
  };
}

/** Convenience for tests and scripts: a scan built straight from rows, no cache. */
export function staticAssignments(rows: readonly AssignmentRow[]): CachedAssignments {
  const scan = buildAgendaScan(rows);
  return { read: () => Promise.resolve(scan) };
}
