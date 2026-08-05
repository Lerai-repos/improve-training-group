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
  set(key: string, value: string, opts?: KvWriteOptions): Promise<void>;
  /** `SET … NX`. True when this call created the key. */
  setIfAbsent(key: string, value: string, opts?: KvWriteOptions): Promise<boolean>;
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

/** The Upstash REST client. HTTP, not TCP — a persistent connection is wrong for serverless. */
export function createRedisClient(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  }
  // Deserialization OFF: we own the encoding. With it on, a stored value that happens
  // to look like JSON comes back as an object and every `string` contract here lies.
  return new Redis({ url, token, automaticDeserialization: false });
}

/** PTTL sentinels: -2 = no such key, -1 = key exists with no expiry. */
const PTTL_ABSENT = -2;
const PTTL_NO_EXPIRY = -1;

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
    async incr(key) {
      return await redis.incr(key);
    },
    async ttl(key) {
      const pttl = await redis.pttl(key);
      if (pttl === PTTL_ABSENT) {
        return { kind: 'absent' };
      }
      if (pttl === PTTL_NO_EXPIRY) {
        return { kind: 'no-expiry' };
      }
      return { kind: 'expires', ms: pttl };
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
