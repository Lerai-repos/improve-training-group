import { z } from 'zod';

import type { Redis } from '@upstash/redis';

import { ZSET_MIN_SCORE, type KvStore } from './kv';

/**
 * Durable queue state. The Redis record IS the job — the same role the
 * `recommendation_runs` row played under Postgres, where dedup, generation
 * allocation and job durability were one transaction.
 *
 * Splitting them is what made an earlier design lose triggers: a dedup marker
 * written before the job was durably queued turned Monday's retry into a no-op.
 * So a record is created ONLY together with its generation, indexed for recovery in
 * the same step, and carries NO expiry until it is genuinely published.
 */

const KEY_TRIGGER = (uuid: string): string => `trigger:${uuid}`;
const KEY_GENERATION = (mondayItemId: string): string => `gen:${mondayItemId}`;
const KEY_PENDING = 'pending';

/**
 * How long a published record is kept for dedup. Longer than Monday's 30-minute
 * retry horizon (`webhook.ts`) so the whole retry storm collapses onto one job.
 */
export const PUBLISHED_TTL_MS = 35 * 60 * 1000;

/** Grace before the sweep considers a fresh record stuck — the webhook usually wins. */
export const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;

export type TriggerStatus = 'pending' | 'published';

const triggerRecordSchema = z.object({
  triggerUuid: z.string(),
  mondayItemId: z.string(),
  generation: z.number().int().positive(),
  status: z.union([z.literal('pending'), z.literal('published')]),
  attempts: z.number().int().nonnegative(),
  /**
   * Repair depth, absent for a record created from a Monday trigger.
   *
   * It has to survive in the RECORD, not just the published payload: a repair the
   * sweep recovers would otherwise reach `runJob` with `hop` undefined, restart the
   * chain at zero, and slip past `MAX_REPAIR_HOPS` entirely.
   */
  hop: z.number().int().nonnegative().optional(),
});

export type TriggerRecord = z.infer<typeof triggerRecordSchema>;

export interface EnqueueInput {
  triggerUuid: string;
  mondayItemId: string;
  nowMs: number;
}

export interface QueueStore {
  /** Atomic get-or-create: allocates the generation and indexes the record together. */
  enqueueOrGet(input: EnqueueInput): Promise<{ record: TriggerRecord; created: boolean }>;
  /** `pending` → `published`: applies the TTL and drops the index entry, atomically. */
  markPublished(triggerUuid: string): Promise<boolean>;
  /** Pending-only. Returns null when the record is absent or already published. */
  bumpAttempt(triggerUuid: string, nextAttemptAtMs: number): Promise<TriggerRecord | null>;
  /**
   * Record a job for an EXISTING generation, so the sweep will publish it. Unlike
   * `enqueueOrGet` this allocates nothing — a repair targets a generation that already
   * exists. Returns false when a record for this id is already present, so repeated
   * failures do not reset its attempt count.
   */
  recordJob(input: {
    triggerUuid: string;
    mondayItemId: string;
    generation: number;
    nowMs: number;
    /** Repair depth, carried so the sweep can republish without resetting the chain. */
    hop?: number;
  }): Promise<boolean>;
  readTrigger(triggerUuid: string): Promise<TriggerRecord | null>;
  /** Index members due at or before `nowMs`, oldest first. */
  dueTriggers(nowMs: number, limit: number): Promise<string[]>;
  removePending(triggerUuid: string): Promise<void>;
  /** The current per-training generation; 0 before any trigger. */
  readGeneration(mondayItemId: string): Promise<number>;
}

/**
 * Unreadable → null, treated as "no such record". `JSON.parse` throws, and letting it
 * escape would wedge the webhook: a single corrupt trigger key would fail every
 * delivery for that uuid instead of letting a fresh record be created over it.
 */
function parseRecord(raw: string | null): TriggerRecord | null {
  if (raw === null) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = triggerRecordSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Store over a plain {@link KvStore}. Transitions are read-modify-write in
 * TypeScript, which is correct but NOT atomic — fine for the single-threaded
 * in-memory store the unit tests use, wrong for a shared Redis. Production uses
 * {@link createUpstashQueueStore}, whose Lua equivalents are kept alongside so the
 * two sets of rules are read together.
 */
export function createQueueStore(kv: KvStore): QueueStore {
  return {
    async enqueueOrGet({ triggerUuid, mondayItemId, nowMs }) {
      const existing = parseRecord(await kv.get(KEY_TRIGGER(triggerUuid)));
      if (existing) {
        return { record: existing, created: false };
      }
      const generation = await kv.incr(KEY_GENERATION(mondayItemId));
      const record: TriggerRecord = {
        triggerUuid,
        mondayItemId,
        generation,
        status: 'pending',
        attempts: 0,
      };
      // No TTL: a pending record that could expire would strand its index entry.
      await kv.set(KEY_TRIGGER(triggerUuid), JSON.stringify(record));
      await kv.zadd(KEY_PENDING, nowMs + FIRST_SWEEP_DELAY_MS, triggerUuid);
      return { record, created: true };
    },

    async recordJob({ triggerUuid, mondayItemId, generation, nowMs, hop }) {
      const record: TriggerRecord = {
        triggerUuid,
        mondayItemId,
        generation,
        status: 'pending',
        attempts: 0,
        ...(hop === undefined ? {} : { hop }),
      };
      const created = await kv.setIfAbsent(KEY_TRIGGER(triggerUuid), JSON.stringify(record));
      if (created) {
        await kv.zadd(KEY_PENDING, nowMs, triggerUuid);
      }
      return created;
    },

    async markPublished(triggerUuid) {
      const record = parseRecord(await kv.get(KEY_TRIGGER(triggerUuid)));
      if (!record || record.status !== 'pending') {
        return false;
      }
      const published: TriggerRecord = { ...record, status: 'published' };
      await kv.set(KEY_TRIGGER(triggerUuid), JSON.stringify(published), {
        ttlMs: PUBLISHED_TTL_MS,
      });
      await kv.zrem(KEY_PENDING, triggerUuid);
      return true;
    },

    async bumpAttempt(triggerUuid, nextAttemptAtMs) {
      const record = parseRecord(await kv.get(KEY_TRIGGER(triggerUuid)));
      if (!record || record.status !== 'pending') {
        return null;
      }
      const bumped: TriggerRecord = { ...record, attempts: record.attempts + 1 };
      await kv.set(KEY_TRIGGER(triggerUuid), JSON.stringify(bumped));
      await kv.zadd(KEY_PENDING, nextAttemptAtMs, triggerUuid);
      return bumped;
    },

    async readTrigger(triggerUuid) {
      return parseRecord(await kv.get(KEY_TRIGGER(triggerUuid)));
    },

    dueTriggers(nowMs, limit) {
      return kv.zRangeByScore(KEY_PENDING, nowMs, limit);
    },

    async removePending(triggerUuid) {
      await kv.zrem(KEY_PENDING, triggerUuid);
    },

    async readGeneration(mondayItemId) {
      const raw = await kv.get(KEY_GENERATION(mondayItemId));
      return raw === null ? 0 : Number(raw);
    },
  };
}

// --- Lua: the same three transitions, made atomic ---------------------------------
// The webhook and the sweep act on one trigger concurrently. Read-modify-write in
// application code lets the sweep's attempt bump write back a stale `pending` record
// over one the webhook has just published — while the webhook has already removed
// the index entry, leaving the trigger stuck pending AND unindexed.

/** KEYS: trigger, generation, pending · ARGV: uuid, itemId, score → [created, record] */
const LUA_ENQUEUE_OR_GET = `
local existing = redis.call('GET', KEYS[1])
if existing then return {0, existing} end
local generation = redis.call('INCR', KEYS[2])
local record = cjson.encode({
  triggerUuid = ARGV[1], mondayItemId = ARGV[2],
  generation = generation, status = 'pending', attempts = 0
})
redis.call('SET', KEYS[1], record)
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
return {1, record}
`;

/** KEYS: trigger, pending · ARGV: uuid, itemId, generation, score, hop → 1 when created */
const LUA_RECORD_JOB = `
if redis.call('GET', KEYS[1]) then return 0 end
local fields = {
  triggerUuid = ARGV[1], mondayItemId = ARGV[2],
  generation = tonumber(ARGV[3]), status = 'pending', attempts = 0
}
-- Empty means "no depth" (a plain trigger); anything else is a repair whose chain
-- position must survive, or the sweep would republish it as a fresh hop 0.
if ARGV[5] ~= '' then fields.hop = tonumber(ARGV[5]) end
redis.call('SET', KEYS[1], cjson.encode(fields))
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return 1
`;

/** KEYS: trigger, pending · ARGV: uuid, ttlMs → 1 when this call transitioned it */
const LUA_MARK_PUBLISHED = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.status ~= 'pending' then return 0 end
record.status = 'published'
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', tonumber(ARGV[2]))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/** KEYS: trigger, pending · ARGV: uuid, nextAttemptAtMs → record, or nil if not pending */
const LUA_BUMP_ATTEMPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local record = cjson.decode(raw)
if record.status ~= 'pending' then return nil end
record.attempts = record.attempts + 1
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return encoded
`;

function requireRecord(raw: unknown, script: string): TriggerRecord {
  if (typeof raw !== 'string') {
    throw new Error(`${script}: expected an encoded record, got ${typeof raw}`);
  }
  const record = parseRecord(raw);
  if (!record) {
    throw new Error(`${script}: record failed validation`);
  }
  return record;
}

export function createUpstashQueueStore(redis: Redis): QueueStore {
  return {
    async enqueueOrGet({ triggerUuid, mondayItemId, nowMs }) {
      const res = await redis.eval(
        LUA_ENQUEUE_OR_GET,
        [KEY_TRIGGER(triggerUuid), KEY_GENERATION(mondayItemId), KEY_PENDING],
        [triggerUuid, mondayItemId, String(nowMs + FIRST_SWEEP_DELAY_MS)]
      );
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error('enqueueOrGet: unexpected script reply');
      }
      return {
        created: res[0] === 1,
        record: requireRecord(res[1], 'enqueueOrGet'),
      };
    },

    async recordJob({ triggerUuid, mondayItemId, generation, nowMs, hop }) {
      const res = await redis.eval(
        LUA_RECORD_JOB,
        [KEY_TRIGGER(triggerUuid), KEY_PENDING],
        [
          triggerUuid,
          mondayItemId,
          String(generation),
          String(nowMs),
          hop === undefined ? '' : String(hop),
        ]
      );
      return res === 1;
    },

    async markPublished(triggerUuid) {
      const res = await redis.eval(
        LUA_MARK_PUBLISHED,
        [KEY_TRIGGER(triggerUuid), KEY_PENDING],
        [triggerUuid, String(PUBLISHED_TTL_MS)]
      );
      return res === 1;
    },

    async bumpAttempt(triggerUuid, nextAttemptAtMs) {
      const res = await redis.eval(
        LUA_BUMP_ATTEMPT,
        [KEY_TRIGGER(triggerUuid), KEY_PENDING],
        [triggerUuid, String(nextAttemptAtMs)]
      );
      return res === null || res === undefined ? null : requireRecord(res, 'bumpAttempt');
    },

    async readTrigger(triggerUuid) {
      return parseRecord(await redis.get<string>(KEY_TRIGGER(triggerUuid)));
    },

    async dueTriggers(nowMs, limit) {
      // `ZSET_MIN_SCORE`, not -Infinity — see its docstring. Getting this wrong made
      // every sweep 500, silently disabling lost-trigger recovery entirely.
      return await redis.zrange<string[]>(KEY_PENDING, ZSET_MIN_SCORE, nowMs, {
        byScore: true,
        offset: 0,
        count: limit,
      });
    },

    async removePending(triggerUuid) {
      await redis.zrem(KEY_PENDING, triggerUuid);
    },

    async readGeneration(mondayItemId) {
      const raw = await redis.get<string>(KEY_GENERATION(mondayItemId));
      return raw === null ? 0 : Number(raw);
    },
  };
}
