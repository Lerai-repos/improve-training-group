import { z } from 'zod';

import { buildAgendaScan, type AgendaScan, type AssignmentRow } from './assignments';
import {
  createSharedCache,
  type CachePeek,
  type RefreshOptions,
  type RefreshOutcome,
} from './shared-cache';

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

/**
 * Twenty minutes, and it MUST outlast the refresh cron's interval by a clear margin.
 *
 * That margin is the whole fix for "de kolommen blijven heel vaak leeg". The scan takes
 * 5.5–8.5 seconds against a board of 839 trainings (nine sequential pages of 100), so
 * when it ran on the planner's own request under a six-second budget it lost roughly one
 * time in three, and the columns went blank. With the cron refreshing every minute, many
 * consecutive runs have to fail before this value can expire, and until it does a slightly
 * older number is served instead of nothing.
 *
 * The TTL is a SURVIVAL margin, not the freshness target — those are two different
 * numbers and conflating them is what makes this look worse than it is. Freshness is the
 * cron interval (one minute); this twenty is how long a value keeps answering while
 * refreshes fail, and it is deliberately many intervals rather than a tight three, because
 * an interval is not a chance: a value that expires *as* the next run begins still leaves
 * a gap while that run takes its 5.5–8.5 seconds.
 *
 * Workload changes when somebody is booked, and a stale count is strictly better than the
 * alternative of being correct or absent.
 */
export const ASSIGNMENTS_TTL_MS = 20 * 60 * 1000;

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

const cachedSchema = z.object({
  workload: z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.number()]))])),
  /**
   * The month is NULLABLE, because `monthByItemId` records undated trainings as `null`
   * on purpose. Requiring a string here would make one undated item on the board reject
   * the entire cache entry on every read — a permanent miss that rescans Monday every
   * time and leaves concurrent waiters showing `—` after a perfectly good refresh.
   */
  months: z.array(z.tuple([z.string(), z.string().nullable()])),
  /** Same nullability, same reason: an undated training is scanned and dateless. */
  dates: z.array(z.tuple([z.string(), z.string().nullable()])),
  days: z.array(
    z.tuple([
      z.string(),
      z.array(
        z.tuple([
          z.string(),
          z.array(
            z.object({
              itemId: z.string(),
              client: z.string().nullable(),
              times: z.string().nullable(),
            })
          ),
        ])
      ),
    ])
  ),
});

function encode(scan: AgendaScan): string {
  return JSON.stringify({
    workload: [...scan.workload].map(([trainer, months]) => [trainer, [...months]]),
    months: [...scan.monthByItemId],
    dates: [...scan.dateByItemId],
    days: [...scan.dayIndex].map(([trainer, days]) => [trainer, [...days]]),
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
    dateByItemId: new Map(result.data.dates),
    dayIndex: new Map(result.data.days.map(([trainer, days]) => [trainer, new Map(days)])),
  };
}

export interface CachedAssignments {
  /** The current scan. Throws when it cannot be determined — never returns an empty one. */
  read(): Promise<AgendaScan>;
  /** The cached scan or nothing, without ever touching Monday. The view's fast path. */
  peek(): Promise<CachePeek<AgendaScan>>;
  /** Rescan and store. The cron's entry point; leaves a cached scan alone on failure. */
  refresh(options?: RefreshOptions): Promise<RefreshOutcome>;
}

export interface CachedAssignmentsDeps {
  kv: KvStore;
  /** The board scan. Fails closed on malformed data, and that failure is propagated. */
  load: () => Promise<AgendaScan>;
  boardId: string;
  ttlMs?: number;
  /** Must exceed the scan's own deadline — see `lockTtlMs` on the shared cache. */
  lockTtlMs?: number;
  /** Injected in tests so waiting for the lock holder costs no real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; production mints a random owner token per refresh. */
  token?: () => string;
}

export function createCachedAssignments(deps: CachedAssignmentsDeps): CachedAssignments {
  // The single-flight lock, the failure sentinel and the owner-only release all live in
  // `createSharedCache`, so the settings reader gets exactly these guarantees rather
  // than a second, subtly different copy of them.
  return createSharedCache<AgendaScan>({
    kv: deps.kv,
    load: deps.load,
    /**
     * `v2`, because the cached shape gained the day index.
     *
     * The strict schema would already reject a v1 payload and degrade to a miss, but the
     * refresh cron writes every minute and a deploy has both versions live at once.
     * A distinct key means the two never meet, instead of every reader burning a rejected
     * decode until the old entry expires.
     */
    key: `assignments:v2:${deps.boardId}`,
    // Unchanged from before the extraction, on purpose — see `lockKey` in shared-cache.
    lockKey: `assignments-lock:${deps.boardId}`,
    encode,
    decode,
    ttlMs: deps.ttlMs ?? ASSIGNMENTS_TTL_MS,
    lockTtlMs: deps.lockTtlMs,
    failureTtlMs: FAILURE_TTL_MS,
    label: 'Workload index',
    sleep: deps.sleep,
    token: deps.token,
  });
}

/** Convenience for tests and scripts: a scan built straight from rows, no cache. */
export function staticAssignments(rows: readonly AssignmentRow[]): CachedAssignments {
  const scan = buildAgendaScan(rows);
  return {
    read: () => Promise.resolve(scan),
    peek: () => Promise.resolve({ kind: 'hit', value: scan }),
    refresh: () => Promise.resolve({ refreshed: true }),
  };
}
