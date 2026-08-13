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
const LOCK_TTL_MS = 30_000;
const WAIT_STEP_MS = 250;
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
  /** Injected in tests so waiting for the lock holder costs no real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; production mints a random owner token per refresh. */
  token?: () => string;
}

export interface SharedCache<T> {
  /** The current value. Throws when it cannot be determined — never returns an empty one. */
  read(): Promise<T>;
}

export function createSharedCache<T>(deps: SharedCacheDeps<T>): SharedCache<T> {
  const { lockKey } = deps;
  const mintToken = deps.token ?? (() => globalThis.crypto.randomUUID());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const decodeRaw = (raw: string | null): T | null => (raw === null ? null : deps.decode(raw));

  return {
    async read() {
      const raw = await deps.kv.get(deps.key);
      if (raw === UNAVAILABLE) {
        throw new Error(`${deps.label} unavailable: a recent refresh failed`);
      }
      const cached = decodeRaw(raw);
      if (cached !== null) {
        return cached;
      }

      const token = mintToken();
      const mine = await deps.kv.setIfAbsent(lockKey, token, { ttlMs: LOCK_TTL_MS });
      if (mine) {
        try {
          const value = await deps.load();
          await deps.kv.set(deps.key, deps.encode(value), { ttlMs: deps.ttlMs });
          return value;
        } catch (error) {
          await deps.kv.set(deps.key, UNAVAILABLE, { ttlMs: deps.failureTtlMs });
          throw error;
        } finally {
          if ((await deps.kv.get(lockKey)) === token) {
            await deps.kv.del(lockKey);
          }
        }
      }

      // Someone else is loading. Wait for their result rather than starting a second
      // read of the same thing.
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
    },
  };
}
