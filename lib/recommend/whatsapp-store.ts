import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Redis } from '@upstash/redis';

import type { KvStore } from './kv';

/**
 * The planner's edited WhatsApp message for one training.
 *
 * Keyed on the TRAINING, not the generation: the message describes the training, and a
 * recalculate must not throw away a note somebody typed. 18% of the real messages in the
 * Airtable corpus carry hand-written additions, so this is the feature, not a nicety.
 *
 * ## The token
 *
 * Concurrency is compare-and-set on `token = sha1(raw stored bytes)`, with a sentinel for
 * "the key does not exist". Two properties fall out of that choice, and both were bought
 * deliberately:
 *
 * - **It survives a malformed value.** The token is a hash of bytes, so a record nobody
 *   can parse still has one — which is what lets the panel overwrite or discard it
 *   instead of being stuck looking at a warning. Nothing on the concurrency path parses,
 *   and the Lua never touches `cjson`, so bad JSON cannot abort the script.
 * - **It has no ABA hole.** A revision counter restarts at 1 after a delete, so a delayed
 *   write holding `rev: 3` can match a brand-new record. A content hash only matches
 *   bytes that are still there.
 *
 * SHA-1 rather than SHA-256 because the comparison happens inside the Redis script and
 * Lua offers `redis.sha1hex` and nothing stronger. This is a concurrency token, not a
 * security primitive: a collision would need two different byte-sequences of our own
 * JSON, the inputs are not attacker-chosen, and everyone who can submit a token already
 * holds `plan` and could overwrite the record legitimately. Accepted, not overlooked.
 *
 * ## The tombstone
 *
 * DELETE writes a tombstone rather than removing the key. Without one, `token: ABSENT`
 * is true again the moment a record is deleted, and a delayed create from before the
 * delete would resurrect it.
 */

/** Ninety days, renewed on write. Free text with a shorter useful life than the rows. */
export const WHATSAPP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Comfortably above the 4.000-character cap on a GENERATED message, so a legitimately
 * long one can always be saved — and low enough that a client cannot park megabytes in
 * Redis.
 */
export const TEXT_MAX_LENGTH = 8000;

/** The token for a key that is not there. Not a hash, and it cannot collide with one. */
export const ABSENT_TOKEN = 'absent';

const storeKey = (mondayItemId: string): string => `whatsapp:${mondayItemId}`;

const recordSchema = z.object({
  v: z.literal(1),
  edited: z.string().min(1).max(TEXT_MAX_LENGTH),
  /** The generated message this edit was made from — the staleness comparison. */
  base: z.string().min(1).max(TEXT_MAX_LENGTH),
  savedAt: z.string(),
});

const tombstoneSchema = z.object({
  v: z.literal(1),
  deleted: z.literal(true),
  at: z.string(),
});

const storedSchema = z.union([recordSchema, tombstoneSchema]);

export interface SavedMessage {
  edited: string;
  base: string;
}

type Stored =
  | { kind: 'record'; saved: SavedMessage }
  | { kind: 'tombstone' }
  /** Present but unparseable — distinct from absent, and recoverable via its token. */
  | { kind: 'unreadable' }
  | { kind: 'absent' };

export interface Snapshot {
  /** The saved edit, or null for absent, discarded, or unreadable. */
  saved: SavedMessage | null;
  token: string;
  /** True when a value IS stored and could not be read. The planner is told. */
  unreadable: boolean;
}

export type WriteOutcome =
  | { kind: 'ok'; saved: SavedMessage | null; token: string }
  | { kind: 'conflict'; saved: SavedMessage | null; token: string; unreadable: boolean };

export interface WhatsappStore {
  read(mondayItemId: string): Promise<Snapshot>;
  save(
    mondayItemId: string,
    input: { edited: string; base: string; token: string }
  ): Promise<WriteOutcome>;
  discard(mondayItemId: string, token: string): Promise<WriteOutcome>;
}

/**
 * The token, computed over exactly the bytes Redis holds.
 *
 * This matching the script's `redis.sha1hex` depends on the client returning the value
 * verbatim — which it does, because `createRedisClient` sets
 * `automaticDeserialization: false` (`kv.ts:177`). If that ever changed, the client would
 * hand back a parsed object, re-encoding could differ by a byte, and every write would
 * conflict. Loudly broken rather than quietly wrong, but worth knowing where to look.
 */
export function tokenOf(raw: string | null): string {
  return raw === null ? ABSENT_TOKEN : createHash('sha1').update(raw).digest('hex');
}

function decode(raw: string | null): Stored {
  if (raw === null) {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  const result = storedSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'unreadable' };
  }
  if ('deleted' in result.data) {
    return { kind: 'tombstone' };
  }
  return { kind: 'record', saved: { edited: result.data.edited, base: result.data.base } };
}

const snapshotOf = (raw: string | null): Snapshot => {
  const stored = decode(raw);
  return {
    saved: stored.kind === 'record' ? stored.saved : null,
    token: tokenOf(raw),
    unreadable: stored.kind === 'unreadable',
  };
};

function encodeRecord(edited: string, base: string, nowIso: string): string {
  return JSON.stringify({ v: 1, edited, base, savedAt: nowIso });
}

function encodeTombstone(nowIso: string): string {
  return JSON.stringify({ v: 1, deleted: true, at: nowIso });
}

/** Reject before any write, so an oversized body cannot reach Redis. */
export function validateText(edited: string, base: string): string | null {
  const result = z
    .object({ edited: z.string().min(1).max(TEXT_MAX_LENGTH), base: z.string().min(1).max(TEXT_MAX_LENGTH) })
    .safeParse({ edited, base });
  return result.success ? null : `edited and base must each be 1..${TEXT_MAX_LENGTH} characters`;
}

/**
 * A conflict that is really the same write arriving twice.
 *
 * Redis commits, the network drops the reply, the client retries with the token it still
 * holds — and a naive CAS answers "a colleague changed this" about the planner's own
 * text. So a mismatch whose stored content is byte-identical to what we were asked to
 * write is reported as success.
 *
 * This lives here rather than in the script because Lua would have to parse to do it:
 * `savedAt` differs between two otherwise identical writes, so whole-record equality is
 * always false, and reaching into the fields means `cjson`, which a malformed value can
 * abort. **The script compares bytes; this compares meaning.**
 */
function reconcileSave(
  current: string | null,
  input: { edited: string; base: string }
): WriteOutcome {
  const snapshot = snapshotOf(current);
  const same =
    snapshot.saved !== null &&
    snapshot.saved.edited === input.edited &&
    snapshot.saved.base === input.base;

  return same
    ? { kind: 'ok', saved: snapshot.saved, token: snapshot.token }
    : { kind: 'conflict', ...snapshot };
}

/** The same rule for DELETE: a tombstone is proof our discard already landed. */
function reconcileDiscard(current: string | null): WriteOutcome {
  const snapshot = snapshotOf(current);
  return decode(current).kind === 'tombstone'
    ? { kind: 'ok', saved: null, token: snapshot.token }
    : { kind: 'conflict', ...snapshot };
}

/**
 * Compare the token, then write. One script, so nothing interleaves.
 *
 * Returns `{ 0, current }` on a mismatch so the caller can reconcile without a second
 * round trip — and `''` for absent, because a Lua table truncates at the first nil. We
 * never write an empty string, so the two cannot be confused.
 */
const LUA_CAS = `
local current = redis.call('GET', KEYS[1])
local token = ARGV[3]
if current then
  token = redis.sha1hex(current)
end
if token ~= ARGV[1] then
  return {0, current or ''}
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[4]))
return {1, ARGV[2]}
`;

export function createUpstashWhatsappStore(
  redis: Redis,
  now: () => Date = () => new Date()
): WhatsappStore {
  const cas = async (
    mondayItemId: string,
    token: string,
    next: string
  ): Promise<{ won: boolean; current: string | null }> => {
    const res = await redis.eval(
      LUA_CAS,
      [storeKey(mondayItemId)],
      [token, next, ABSENT_TOKEN, String(WHATSAPP_TTL_MS)]
    );
    if (!Array.isArray(res) || res.length !== 2) {
      throw new Error('whatsapp store: unexpected script reply');
    }
    const [won, value] = res;
    return { won: won === 1, current: value === '' ? null : String(value) };
  };

  return {
    async read(mondayItemId) {
      return snapshotOf(await redis.get<string>(storeKey(mondayItemId)));
    },

    async save(mondayItemId, { edited, base, token }) {
      const next = encodeRecord(edited, base, now().toISOString());
      const { won, current } = await cas(mondayItemId, token, next);
      return won
        ? { kind: 'ok', saved: { edited, base }, token: tokenOf(next) }
        : reconcileSave(current, { edited, base });
    },

    async discard(mondayItemId, token) {
      const next = encodeTombstone(now().toISOString());
      const { won, current } = await cas(mondayItemId, token, next);
      return won ? { kind: 'ok', saved: null, token: tokenOf(next) } : reconcileDiscard(current);
    },
  };
}

/**
 * The twin, over a plain {@link KvStore}, for tests.
 *
 * Serialized per training on purpose. Being in one process is not being atomic: a
 * `get` then `set` across two awaits lets two concurrent saves both observe the same
 * token and both win, which production's single script cannot do. A twin that can is
 * worse than no twin — every concurrency test written against it would assert behaviour
 * production does not have. Same argument, same shape, as `createOutcomeStore`.
 */
export function createWhatsappStore(kv: KvStore, now: () => Date = () => new Date()): WhatsappStore {
  const tails = new Map<string, Promise<unknown>>();

  function serialize<T>(mondayItemId: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(mondayItemId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.catch(() => undefined);
    tails.set(mondayItemId, tail);
    void tail.then(() => {
      if (tails.get(mondayItemId) === tail) {
        tails.delete(mondayItemId);
      }
    });
    return run;
  }

  const cas = async (
    mondayItemId: string,
    token: string,
    next: string
  ): Promise<{ won: boolean; current: string | null }> => {
    const current = await kv.get(storeKey(mondayItemId));
    if (tokenOf(current) !== token) {
      return { won: false, current };
    }
    await kv.set(storeKey(mondayItemId), next, { ttlMs: WHATSAPP_TTL_MS });
    return { won: true, current: next };
  };

  return {
    read(mondayItemId) {
      return serialize(mondayItemId, async () => snapshotOf(await kv.get(storeKey(mondayItemId))));
    },

    save(mondayItemId, { edited, base, token }) {
      return serialize(mondayItemId, async () => {
        const next = encodeRecord(edited, base, now().toISOString());
        const { won, current } = await cas(mondayItemId, token, next);
        return won
          ? { kind: 'ok' as const, saved: { edited, base }, token: tokenOf(next) }
          : reconcileSave(current, { edited, base });
      });
    },

    discard(mondayItemId, token) {
      return serialize(mondayItemId, async () => {
        const next = encodeTombstone(now().toISOString());
        const { won, current } = await cas(mondayItemId, token, next);
        return won
          ? { kind: 'ok' as const, saved: null, token: tokenOf(next) }
          : reconcileDiscard(current);
      });
    },
  };
}
