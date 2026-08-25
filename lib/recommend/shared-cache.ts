import type { KvStore } from './kv';

/**
 * A short-lived, single-flight, fail-loud cache over one expensive read.
 *
 * Extracted from the workload cache so the settings reader gets the *same* guarantees
 * rather than a second copy of them. Three properties, each of which was learned the
 * hard way and none of which is obvious:
 *
 * **Single-flight.** A plain cache is not enough: when it expires, every in-flight
 * request misses at the same moment and they all do the expensive read together — the
 * stampede the cache existed to prevent, concentrated into one second. One caller takes
 * a lock and refreshes; the rest wait briefly for its result.
 *
 * **A failure is remembered, briefly, and is never an empty value.** Without the
 * sentinel a rejected read leaves nothing behind and the next caller starts the same
 * doomed read again. Caching an empty value instead would be worse still: for workload
 * it reads as "nobody is busy", for settings as "no configuration", and both are
 * plausible enough to act on.
 *
 * **The lock is released only by its owner.** A read that outlives the lease lets
 * someone else acquire a fresh lock; deleting unconditionally would free theirs and
 * re-open the stampede. Read-then-delete narrows that to microseconds rather than
 * closing it — the lock is a stampede guard, not a correctness mechanism, so a cheap
 * check is the right weight of solution.
 */

/** Long enough for a slow read, short enough that a crashed holder unblocks quickly. */
const DEFAULT_LOCK_TTL_MS = 30_000;
const WAIT_STEP_MS = 250;
/**
 * The poll step while waiting out a contending holder.
 *
 * Coarser than `WAIT_STEP_MS` because nobody is watching: this loop can legitimately run
 * for as long as the lock may be held, and at two Redis commands per turn a 250ms step
 * would spend hundreds of commands on the rare occasion a real scan is running long.
 */
const CONTENDED_STEP_MS = 500;
/** Three seconds. Right for a board scan the caller can degrade without. */
const DEFAULT_MAX_WAIT_MS = 3_000;

/** Distinct from a cached value: "we tried and could not", never an empty result. */
const UNAVAILABLE = '"unavailable"';

export interface SharedCacheDeps<T> {
  kv: KvStore;
  /** The expensive read. Must fail closed; its failure is propagated, never swallowed. */
  load: () => Promise<T>;
  /** Cache key. Callers namespace it — including by board, deployment, whatever varies. */
  key: string;
  /**
   * The single-flight lock key, passed explicitly rather than derived from `key`.
   *
   * Deriving it would have quietly renamed the existing workload lock during this
   * extraction, and two deployments disagreeing about the lock's name do not exclude
   * each other — exactly the stampede the lock exists to prevent, at the one moment
   * (a rollout) when load is already unusual.
   */
  lockKey: string;
  encode: (value: T) => string;
  /** Returns null for anything unparseable, which simply counts as a miss. */
  decode: (raw: string) => T | null;
  ttlMs: number;
  /**
   * How long a failure is remembered. Deliberately its own number and much shorter than
   * `ttlMs`: give a failure the data TTL and one brief outage poisons every retry
   * downstream of it.
   */
  failureTtlMs: number;
  /** Used in the error message, so a thrown cache miss says what was unavailable. */
  label: string;
  /**
   * How long a waiter will wait for the lock holder before giving up.
   *
   * Must exceed how long `load` actually takes, or every concurrent caller at cache
   * expiry fails while the holder is still succeeding — and on the engine path that
   * burns a QStash attempt for a refresh that was about to work. The workload scan can
   * degrade to `—` after three seconds; a settings read cannot, and it makes several
   * sequential Monday requests, so it asks for more.
   */
  maxWaitMs?: number;
  /**
   * How long the single-flight lock is held before it lapses.
   *
   * MUST exceed how long `load` can actually run. A lease shorter than the read is not a
   * lock at all: it expires mid-scan, the next caller acquires it and starts a second
   * scan of the same board, which is precisely the duplicate work this exists to prevent
   * — and it happens exactly when the read is already slow. Thirty seconds fits a request
   * -path read; a scheduled one that budgets sixty has to say so.
   */
  lockTtlMs?: number;
  /** Injected in tests so waiting for the lock holder costs no real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; production mints a random owner token per refresh. */
  token?: () => string;
}

/**
 * What is in the cache right now, WITHOUT loading anything.
 *
 * `failed` is deliberately distinct from `miss`: a caller that reacts to a miss by
 * scheduling a refresh would, on a `miss`-shaped failure, start a fresh read on every
 * request for exactly as long as the outage lasts. That is the stampede `failureTtlMs`
 * exists to prevent, so the sentinel has to stay legible out here.
 */
export type CachePeek<T> = { kind: 'hit'; value: T } | { kind: 'miss' } | { kind: 'failed' };

export interface RefreshOutcome {
  /** False when another refresh owns the work — see `reason` for how much that promises. */
  refreshed: boolean;
  /**
   * `locked`: another refresh finished and its value IS cached — seen, not assumed.
   * `contended`: somebody else holds the lock and nothing about the cache is confirmed.
   *
   * Only a caller that has actually read a usable value may report `locked`. Without
   * `awaitContended` nobody looks, so a contested refresh always reports `contended`:
   * accurate, and it keeps `locked` worth trusting for the callers that act on it.
   */
  reason?: 'locked' | 'contended';
}

export interface RefreshOptions {
  /**
   * On finding the lock held, wait for that holder's result and take over if it produced
   * nothing.
   *
   * For a scheduled refresh, whose whole job is that a value exists afterwards. A caller
   * with its own short deadline — the request path warming a cold cache — should leave
   * this off and let the next tick handle it, rather than sitting in a poll loop the user
   * is waiting on.
   */
  awaitContended?: boolean;
  /**
   * How long to keep waiting before giving up and reporting `contended`.
   *
   * Defaults to the lock's own lease, which is the longest a holder can legitimately keep
   * it: past that the lock has lapsed and the work is takeable anyway. A shorter value is
   * only correct if the caller genuinely cannot afford to wait.
   */
  contendedWaitMs?: number;
}

export interface SharedCache<T> {
  /** The current value. Throws when it cannot be determined — never returns an empty one. */
  read(): Promise<T>;
  /** The cached value or nothing. Never loads, never waits, never throws. */
  peek(): Promise<CachePeek<T>>;
  /**
   * Recompute and store, whatever is cached — the scheduled-refresh path.
   *
   * Differs from {@link SharedCache.read} in what a failure does, and the rule is about
   * what was there to lose. `read` only ever loads on a miss, so it can always record
   * the failure. `refresh` may run while a perfectly good value is cached, and blanking
   * that because one scheduled run could not reach Monday would empty the columns this
   * mechanism exists to keep filled — so a cached value survives untouched.
   *
   * With nothing cached there is nothing to protect, and the failure IS recorded: a miss
   * is what makes a caller schedule another refresh, so staying silent would turn an
   * outage into a scan on every poll. Either way it throws.
   *
   * `refreshed: false` means another refresh held the lock — NOT that a value now exists.
   * See {@link RefreshOptions.awaitContended} for the scheduled caller that cannot accept
   * that distinction.
   */
  refresh(options?: RefreshOptions): Promise<RefreshOutcome>;
}

export function createSharedCache<T>(deps: SharedCacheDeps<T>): SharedCache<T> {
  const { lockKey } = deps;
  const mintToken = deps.token ?? (() => globalThis.crypto.randomUUID());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const decodeRaw = (raw: string | null): T | null => (raw === null ? null : deps.decode(raw));

  /** Take the single-flight lock, run `body`, release it only if we still own it. */
  const withLock = async <R>(
    body: () => Promise<R>,
    contended: () => R | Promise<R>
  ): Promise<R> => {
    const token = mintToken();
    const mine = await deps.kv.setIfAbsent(lockKey, token, {
      ttlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    });
    if (!mine) {
      return contended();
    }
    try {
      return await body();
    } finally {
      if ((await deps.kv.get(lockKey)) === token) {
        await deps.kv.del(lockKey);
      }
    }
  };

  /** Load, store, and record a failure only when there was nothing cached to protect. */
  const loadAndStore = async (): Promise<RefreshOutcome> => {
    try {
      const value = await deps.load();
      await deps.kv.set(deps.key, deps.encode(value), { ttlMs: deps.ttlMs });
      return { refreshed: true };
    } catch (error) {
      /**
       * Two different failures, and only one of them may be recorded.
       *
       * Failing while a good value is still cached must leave that value alone —
       * blanking it because one scheduled run could not reach Monday is exactly what the
       * long TTL exists to prevent.
       *
       * Failing with NOTHING cached is the opposite case, and leaving no trace is its own
       * bug: a miss is what makes a caller schedule a refresh, so every 20-second poll
       * from every open tab would start another full read for as long as the outage
       * lasts. The sentinel and its much shorter TTL are the only thing that stops it, so
       * a cold failure has to be written down.
       */
      const existing = decodeRaw(await deps.kv.get(deps.key));
      if (existing === null) {
        await deps.kv.set(deps.key, UNAVAILABLE, { ttlMs: deps.failureTtlMs });
      }
      throw error;
    }
  };

  /**
   * Wait out a contending holder, taking the work over the moment it lets go.
   *
   * Returns the outcome, or null if the holder was still going when patience ran out.
   *
   * Two things this must NOT do, both learned from getting them wrong:
   *
   * **Give up before the holder can.** A fixed short wait is worthless here, because the
   * likeliest holder is a request-path warm-up whose own deadline is longer than the
   * wait. Stopping first means reporting `locked` at three seconds for a holder that
   * fails at six, leaving nothing cached. So the bound is how long the lock can
   * legitimately be held at all.
   *
   * **Treat the failure sentinel as an answer.** A failed holder writes the sentinel and
   * releases the lock as two separate steps, so a single look in between sees "no usable
   * value, lock still held" and would wrongly conclude somebody is working on it. Only a
   * DECODABLE value ends the wait; anything else keeps reaching for the lock, which is
   * the one thing that says whether the work is free to take.
   */
  const awaitOrTakeOver = async (waitMs: number): Promise<RefreshOutcome | null> => {
    const steps = Math.ceil(waitMs / CONTENDED_STEP_MS);
    for (let step = 0; step < steps; step += 1) {
      await sleep(CONTENDED_STEP_MS);
      if (decodeRaw(await deps.kv.get(deps.key)) !== null) {
        // The holder succeeded. Its result is the answer, and scanning again would only
        // repeat work that just finished.
        return { refreshed: false, reason: 'locked' };
      }
      const taken = await withLock<RefreshOutcome | null>(loadAndStore, () => null);
      if (taken !== null) {
        return taken;
      }
    }
    return null;
  };

  return {
    async peek() {
      const raw = await deps.kv.get(deps.key);
      if (raw === UNAVAILABLE) {
        return { kind: 'failed' };
      }
      const cached = decodeRaw(raw);
      return cached === null ? { kind: 'miss' } : { kind: 'hit', value: cached };
    },

    async refresh(options) {
      /**
       * `contended`, never `locked`, and the distinction is the contract.
       *
       * All this branch knows is that somebody else holds the lock. Whether they will
       * produce anything is exactly what it has not established, so claiming `locked` —
       * which promises a usable cached value — would hand every caller the false success
       * this whole mechanism exists to prevent. Only {@link awaitOrTakeOver}, which has
       * actually seen a decodable value, may say `locked`.
       */
      const attempt = (): Promise<RefreshOutcome> =>
        withLock<RefreshOutcome>(loadAndStore, () => ({ refreshed: false, reason: 'contended' }));

      const first = await attempt();
      if (first.refreshed || options?.awaitContended !== true) {
        return first;
      }

      /**
       * `locked` does not mean "done" — it means somebody else started.
       *
       * And that somebody is usually a planner's own warm-up, which budgets six seconds
       * against a read that needs eight. A scheduled run that treated the lock as proof
       * of success would let that warm-up time out and leave the value missing until the
       * next tick, having reported 200.
       *
       * So a caller that asks for it stays until there is either a usable value or a free
       * lock, bounded by the longest the lock can legitimately be held. Running out of
       * that is reported as `contended` rather than `locked`, because the two say very
       * different things: one confirms a value is cached, the other only that somebody
       * else was still busy.
       */
      const settled = await awaitOrTakeOver(
        options.contendedWaitMs ?? deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
      );
      return settled ?? { refreshed: false, reason: 'contended' };
    },

    async read() {
      const raw = await deps.kv.get(deps.key);
      if (raw === UNAVAILABLE) {
        throw new Error(`${deps.label} unavailable: a recent refresh failed`);
      }
      const cached = decodeRaw(raw);
      if (cached !== null) {
        return cached;
      }

      return await withLock(
        async () => {
          try {
            const value = await deps.load();
            await deps.kv.set(deps.key, deps.encode(value), { ttlMs: deps.ttlMs });
            return value;
          } catch (error) {
            // Safe here, unlike in `refresh`: this path is only reached on a miss, so
            // there is no good value to overwrite.
            await deps.kv.set(deps.key, UNAVAILABLE, { ttlMs: deps.failureTtlMs });
            throw error;
          }
        },
        // Someone else is loading. Wait for their result rather than starting a second
        // read of the same thing.
        async () => {
          const steps = Math.ceil((deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) / WAIT_STEP_MS);
          for (let step = 0; step < steps; step += 1) {
            await sleep(WAIT_STEP_MS);
            const latest = await deps.kv.get(deps.key);
            // The holder may have failed fast. Recognise that here too, or every waiter
            // spends the full three seconds polling for an answer that already exists.
            if (latest === UNAVAILABLE) {
              throw new Error(`${deps.label} unavailable: the refresh in front of us failed`);
            }
            const fresh = decodeRaw(latest);
            if (fresh !== null) {
              return fresh;
            }
          }
          throw new Error(`${deps.label} unavailable: the refresh in front of us did not finish`);
        }
      );
    },
  };
}
