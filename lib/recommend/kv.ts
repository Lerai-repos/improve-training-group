import { Redis } from '@upstash/redis';

/**
 * The key/value seam. Everything this system keeps outside Monday lives here: the
 * durable trigger records, the per-training generation counter, the immutable
 * per-generation outcomes, and the travel cache.
 *
 * Two semantics are load-bearing and must match Redis exactly, because correctness
 * arguments rest on them:
 *
 *   - `setIfAbsent` (`SET … NX`) picks the single winner for an immutable outcome,
 *     so a retry can never flip a label that was already computed.
 *   - the TTL / no-TTL distinction. A pending trigger record is written WITHOUT an
 *     expiry on purpose: if it could expire, a long outage would leave the pending
 *     index holding a bare uuid with no record to recover it from. The expiry is
 *     applied only once the job is durably queued.
 */

/** Absent, alive-forever, or alive-with-a-deadline — distinguished, never conflated. */
export type TtlState = { kind: 'absent' } | { kind: 'no-expiry' } | { kind: 'expires'; ms: number };

export interface KvWriteOptions {
  /** Omit for no expiry. */
  ttlMs?: number;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  /**
   * Several keys in one round trip, positionally aligned with `keys`; a missing key is
   * `null`, never a hole or a shortened array.
   *
   * The item view reads one `approached:` key per recommended trainer, and a list can
   * run to dozens — sequential GETs would put a serverless round trip between the
   * planner and every row.
   */
  mget(keys: readonly string[]): Promise<(string | null)[]>;
  set(key: string, value: string, opts?: KvWriteOptions): Promise<void>;
  /** `SET … NX`. True when this call created the key. */
  setIfAbsent(key: string, value: string, opts?: KvWriteOptions): Promise<boolean>;
  /** Idempotent: deleting an absent key is not an error. */
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  ttl(key: string): Promise<TtlState>;
  /** Sorted-set ops — the durable pending index. */
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zRangeByScore(key: string, maxScore: number, limit: number): Promise<string[]>;
}

interface MemoryEntry {
  value: string;
  /** Absolute ms epoch, or null for no expiry. */
  expiresAtMs: number | null;
}

/**
 * In-process store for tests. `now` is injectable so TTL boundaries are testable
 * without waiting, exactly as `createTravelCache` already does.
 */
export function createMemoryKvStore(now: () => number = Date.now): KvStore {
  const map = new Map<string, MemoryEntry>();
  const zsets = new Map<string, Map<string, number>>();

  const live = (key: string): MemoryEntry | null => {
    const entry = map.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= now()) {
      map.delete(key);
      return null;
    }
    return entry;
  };

  const expiryFor = (opts?: KvWriteOptions): number | null =>
    opts?.ttlMs === undefined ? null : now() + opts.ttlMs;

  return {
    get(key) {
      return Promise.resolve(live(key)?.value ?? null);
    },
    mget(keys) {
      return Promise.resolve(keys.map((key) => live(key)?.value ?? null));
    },
    set(key, value, opts) {
      map.set(key, { value, expiresAtMs: expiryFor(opts) });
      return Promise.resolve();
    },
    setIfAbsent(key, value, opts) {
      if (live(key)) {
        return Promise.resolve(false);
      }
      map.set(key, { value, expiresAtMs: expiryFor(opts) });
      return Promise.resolve(true);
    },
    del(key) {
      map.delete(key);
      return Promise.resolve();
    },
    incr(key) {
      const current = live(key);
      const next = (current ? Number(current.value) : 0) + 1;
      map.set(key, { value: String(next), expiresAtMs: current?.expiresAtMs ?? null });
      return Promise.resolve(next);
    },
    ttl(key) {
      const entry = live(key);
      if (!entry) {
        return Promise.resolve<TtlState>({ kind: 'absent' });
      }
      if (entry.expiresAtMs === null) {
        return Promise.resolve<TtlState>({ kind: 'no-expiry' });
      }
      return Promise.resolve<TtlState>({ kind: 'expires', ms: entry.expiresAtMs - now() });
    },
    zadd(key, score, member) {
      const set = zsets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      zsets.set(key, set);
      return Promise.resolve();
    },
    zrem(key, member) {
      zsets.get(key)?.delete(member);
      return Promise.resolve();
    },
    zRangeByScore(key, maxScore, limit) {
      const set = zsets.get(key);
      if (!set) {
        return Promise.resolve([]);
      }
      const due = [...set.entries()]
        .filter(([, score]) => score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
      return Promise.resolve(due);
    },
  };
}

/** First non-blank value. Blank is treated as absent — a set-but-empty var is not a value. */
function firstSet(...names: string[]): string | null {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim();
    if (value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * The Upstash REST client. HTTP, not TCP — a persistent connection is wrong for
 * serverless.
 *
 * Accepts the `KV_REST_API_*` aliases because that is what Vercel's Upstash
 * marketplace integration actually injects, carried over from when this was Vercel KV.
 * Taking both avoids hand-duplicated variables that drift apart.
 *
 * `KV_REST_API_READ_ONLY_TOKEN` is deliberately NOT accepted: it authenticates but
 * rejects writes, so falling back to it would produce a client that reads fine and
 * fails every enqueue — the sort of half-working state that is worse than not
 * connecting at all.
 */
export function createRedisClient(): Redis {
  const url = firstSet('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL');
  const token = firstSet('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
  if (!url || !token) {
    throw new Error(
      'Missing Redis credentials — set UPSTASH_REDIS_REST_URL/_TOKEN (or Vercel’s KV_REST_API_URL/_TOKEN)'
    );
  }
  // Deserialization OFF: we own the encoding. With it on, a stored value that happens
  // to look like JSON comes back as an object and every `string` contract here lies.
  return new Redis({ url, token, automaticDeserialization: false });
}

/** PTTL sentinels: -2 = no such key, -1 = key exists with no expiry. */
const PTTL_ABSENT = -2;
const PTTL_NO_EXPIRY = -1;

/**
 * The two sentinels are easy to mistake for durations — `-1` in particular reads as
 * "already expired" rather than "never expires", which is the opposite. Anything
 * translating a `PTTL` reply goes through here so that reading is done once.
 */
export function ttlStateFromPttl(pttl: number): TtlState {
  if (pttl === PTTL_ABSENT) {
    return { kind: 'absent' };
  }
  if (pttl === PTTL_NO_EXPIRY) {
    return { kind: 'no-expiry' };
  }
  return { kind: 'expires', ms: pttl };
}

/**
 * Redis' literal for "unbounded below" in a BYSCORE range. It must be the STRING
 * `-inf`, never `Number.NEGATIVE_INFINITY`.
 *
 * The Upstash client forwards range bounds verbatim into the command array and posts
 * it with `JSON.stringify`, and JSON has no representation for infinity — so
 * `-Infinity` silently becomes `null` and Redis receives `ZRANGE key null <max>
 * BYSCORE`, which errors on every call. Nothing catches it in a unit test, because the
 * in-memory store never sees these arguments.
 */
export const ZSET_MIN_SCORE = '-inf';

export function createUpstashKvStore(redis: Redis): KvStore {
  return {
    async get(key) {
      return await redis.get<string>(key);
    },
    async mget(keys) {
      // MGET with no arguments is a Redis syntax error, and the caller asking for
      // nothing is entirely normal — a training with no rows yet has no trainers to
      // look up.
      if (keys.length === 0) {
        return [];
      }
      const values = await redis.mget<(string | null)[]>(...keys);
      // Defensive, and cheap: the positional contract is the whole point of this
      // method, and a caller zipping a short array against its keys would silently
      // attribute one trainer's state to another.
      if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error(`MGET returned ${values?.length ?? 'no'} values for ${keys.length} keys`);
      }
      return values.map((value) => value ?? null);
    },
    async set(key, value, opts) {
      await (opts?.ttlMs === undefined
        ? redis.set(key, value)
        : redis.set(key, value, { px: opts.ttlMs }));
    },
    async setIfAbsent(key, value, opts) {
      const res =
        opts?.ttlMs === undefined
          ? await redis.set(key, value, { nx: true })
          : await redis.set(key, value, { nx: true, px: opts.ttlMs });
      return res === 'OK';
    },
    async del(key) {
      await redis.del(key);
    },
    async incr(key) {
      return await redis.incr(key);
    },
    async ttl(key) {
      return ttlStateFromPttl(await redis.pttl(key));
    },
    async zadd(key, score, member) {
      await redis.zadd(key, { score, member });
    },
    async zrem(key, member) {
      await redis.zrem(key, member);
    },
    async zRangeByScore(key, maxScore, limit) {
      return await redis.zrange<string[]>(key, ZSET_MIN_SCORE, maxScore, {
        byScore: true,
        offset: 0,
        count: limit,
      });
    },
  };
}
