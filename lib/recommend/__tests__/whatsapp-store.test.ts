import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import {
  ABSENT_TOKEN,
  TEXT_MAX_LENGTH,
  WHATSAPP_TTL_MS,
  createWhatsappStore,
  tokenOf,
  validateText,
  type WhatsappStore,
} from '../whatsapp-store';

import type { KvStore } from '../kv';

/**
 * The token contract. Every test here is a race or a partial failure, because that is
 * the only reason this store is more than `get`/`set`.
 *
 * **These run against the twin, not against the Lua.** `redis.sha1hex` needs a real
 * Redis, so the script cannot be exercised here — the same gap `outcome.ts` and
 * `queue-store.ts` have, and handled the same way: the twin is written to the identical
 * rules and kept beside the script so the two are read together, and the script itself
 * is verified live by `pnpm view:smoke --mutate` (docs/m2b/README.md).
 *
 * The twin serializes per training deliberately. An unserialized read-modify-write would
 * let two concurrent saves both observe the same token and both win — something the
 * single script cannot do — and every conflict test below would then be asserting
 * behaviour production does not have.
 */

const ITEM = '3141071021';
const KEY = `whatsapp:${ITEM}`;

describe('the whatsapp store', () => {
  let kv: KvStore;
  let store: WhatsappStore;
  let now: Date;

  beforeEach(() => {
    kv = createMemoryKvStore();
    now = new Date('2026-08-11T09:00:00.000Z');
    store = createWhatsappStore(kv, () => now);
  });

  describe('reading nothing', () => {
    it('reports absent with the sentinel token', async () => {
      expect(await store.read(ITEM)).toEqual({
        saved: null,
        token: ABSENT_TOKEN,
        unreadable: false,
      });
    });
  });

  describe('the happy path', () => {
    it('saves against the absent token and reads back', async () => {
      const write = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(write.kind).toBe('ok');
      const read = await store.read(ITEM);
      expect(read.saved).toEqual({ edited: 'D', base: 'S' });
      expect(read.token).toBe(write.token);
      expect(read.token).not.toBe(ABSENT_TOKEN);
    });

    it('advances the token on every write, so a queued save has something to use', async () => {
      const first = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      now = new Date('2026-08-11T09:00:01.000Z');
      const second = await store.save(ITEM, { edited: 'D2', base: 'S', token: first.token });

      expect(second.kind).toBe('ok');
      expect(second.token).not.toBe(first.token);
      expect((await store.read(ITEM)).saved).toEqual({ edited: 'D2', base: 'S' });
    });

    it('renews the lifetime on write', async () => {
      let clock = 0;
      const timed = createMemoryKvStore(() => clock);
      const timedStore = createWhatsappStore(timed, () => now);
      await timedStore.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      clock = WHATSAPP_TTL_MS - 1;
      const midlife = await timedStore.read(ITEM);
      await timedStore.save(ITEM, { edited: 'D2', base: 'S', token: midlife.token });

      clock = WHATSAPP_TTL_MS + 1;
      expect((await timedStore.read(ITEM)).saved).toEqual({ edited: 'D2', base: 'S' });
    });
  });

  describe('conflicts', () => {
    it('refuses a stale token and hands back what is really there', async () => {
      await store.save(ITEM, { edited: 'mine', base: 'S', token: ABSENT_TOKEN });

      const result = await store.save(ITEM, {
        edited: 'theirs',
        base: 'S',
        token: ABSENT_TOKEN,
      });

      expect(result.kind).toBe('conflict');
      expect(result.saved).toEqual({ edited: 'mine', base: 'S' });
      expect((await store.read(ITEM)).saved).toEqual({ edited: 'mine', base: 'S' });
    });

    it('lets the loser retry with the token it was given', async () => {
      await store.save(ITEM, { edited: 'mine', base: 'S', token: ABSENT_TOKEN });
      const rejected = await store.save(ITEM, { edited: 'theirs', base: 'S', token: ABSENT_TOKEN });

      const retry = await store.save(ITEM, {
        edited: 'theirs',
        base: 'S',
        token: rejected.token,
      });

      expect(retry.kind).toBe('ok');
    });
  });

  /**
   * Redis committed, the network dropped the reply, the client retried. Without this the
   * planner is told a colleague changed their own text — and `Verwerpen` can no longer
   * tell a local draft from a committed server edit.
   */
  describe('a lost response', () => {
    it('treats a retried identical save as success, not a conflict', async () => {
      const committed = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      // Same request again, with the token the client still holds.
      const retry = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(retry.kind).toBe('ok');
      expect(retry.token).toBe(committed.token);
      expect(retry.saved).toEqual({ edited: 'D', base: 'S' });
    });

    /** `savedAt` differs, so the RECORDS are not byte-identical — only the content is. */
    it('recognises it even though the stored bytes differ', async () => {
      await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      now = new Date('2026-08-11T10:30:00.000Z');

      const retry = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(retry.kind).toBe('ok');
    });

    it('treats a retried discard as success, the tombstone being the proof', async () => {
      const saved = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      const discarded = await store.discard(ITEM, saved.token);

      const retry = await store.discard(ITEM, saved.token);

      expect(retry.kind).toBe('ok');
      expect(retry.token).toBe(discarded.token);
    });

    /** The idempotent path must not swallow a genuine conflict. */
    it('still conflicts when somebody else wrote in the meantime', async () => {
      await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      const mine = await store.read(ITEM);
      now = new Date('2026-08-11T11:00:00.000Z');
      await store.save(ITEM, { edited: 'colleague', base: 'S', token: mine.token });

      const retry = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(retry.kind).toBe('conflict');
      expect(retry.saved).toEqual({ edited: 'colleague', base: 'S' });
    });

    it('conflicts on a retried discard once the record was re-created', async () => {
      const saved = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      const discarded = await store.discard(ITEM, saved.token);
      await store.save(ITEM, { edited: 'fresh', base: 'S', token: discarded.token });

      const retry = await store.discard(ITEM, saved.token);

      expect(retry.kind).toBe('conflict');
      expect(retry.saved).toEqual({ edited: 'fresh', base: 'S' });
    });
  });

  /**
   * The hole a revision counter leaves: delete restarts numbering, so `rev: 1` from
   * before the delete matches the `rev: 1` of a brand-new record. A content hash cannot.
   */
  describe('the tombstone', () => {
    it('refuses a create from before a delete', async () => {
      const saved = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      await store.discard(ITEM, saved.token);

      const late = await store.save(ITEM, { edited: 'late', base: 'S', token: ABSENT_TOKEN });

      expect(late.kind).toBe('conflict');
      expect((await store.read(ITEM)).saved).toBeNull();
    });

    it('refuses a stale write across delete → create', async () => {
      const first = await store.save(ITEM, { edited: 'first', base: 'S', token: ABSENT_TOKEN });
      const gone = await store.discard(ITEM, first.token);
      await store.save(ITEM, { edited: 'second', base: 'S', token: gone.token });

      const stale = await store.save(ITEM, { edited: 'stale', base: 'S', token: first.token });

      expect(stale.kind).toBe('conflict');
      expect((await store.read(ITEM)).saved).toEqual({ edited: 'second', base: 'S' });
    });

    it('reads as no saved message', async () => {
      const saved = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });
      await store.discard(ITEM, saved.token);

      const read = await store.read(ITEM);
      expect(read.saved).toBeNull();
      expect(read.unreadable).toBe(false);
      expect(read.token).not.toBe(ABSENT_TOKEN);
    });
  });

  /**
   * A hash of raw bytes needs no parsing, which is exactly what makes an unreadable
   * record recoverable rather than merely reported.
   */
  describe('an unreadable record', () => {
    beforeEach(async () => {
      await kv.set(KEY, '{ this is not json');
    });

    it('says so, rather than pretending nothing is saved', async () => {
      const read = await store.read(ITEM);

      expect(read.saved).toBeNull();
      expect(read.unreadable).toBe(true);
      expect(read.token).not.toBe(ABSENT_TOKEN);
    });

    it('can be overwritten with the token it reported', async () => {
      const read = await store.read(ITEM);

      const write = await store.save(ITEM, { edited: 'D', base: 'S', token: read.token });

      expect(write.kind).toBe('ok');
      expect((await store.read(ITEM)).saved).toEqual({ edited: 'D', base: 'S' });
    });

    it('can be discarded with the token it reported', async () => {
      const read = await store.read(ITEM);

      expect((await store.discard(ITEM, read.token)).kind).toBe('ok');
      expect((await store.read(ITEM)).unreadable).toBe(false);
    });

    it('is a conflict for a writer who never saw it', async () => {
      expect((await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN })).kind).toBe(
        'conflict'
      );
    });

    /** Equality cannot be established against bytes nobody can parse. */
    it('never takes the idempotent path', async () => {
      const result = await store.save(ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(result.kind).toBe('conflict');
      expect(result.kind === 'conflict' && result.unreadable).toBe(true);
    });

    /** A schema-valid but wrong-shaped record is unreadable too, not silently accepted. */
    it('covers a well-formed value of the wrong shape', async () => {
      await kv.set(KEY, JSON.stringify({ v: 2, edited: 'D' }));

      expect((await store.read(ITEM)).unreadable).toBe(true);
    });
  });

  describe('bounds', () => {
    it('rejects an oversized edit before it reaches Redis', () => {
      expect(validateText('x'.repeat(TEXT_MAX_LENGTH + 1), 'S')).toMatch(/8000/);
      expect(validateText('D', 'x'.repeat(TEXT_MAX_LENGTH + 1))).toMatch(/8000/);
    });

    it('accepts a message at the limit', () => {
      expect(validateText('x'.repeat(TEXT_MAX_LENGTH), 'S')).toBeNull();
    });

    it('rejects an empty edit — that is a discard, not a save', () => {
      expect(validateText('', 'S')).not.toBeNull();
    });
  });

  describe('tokenOf', () => {
    it('is the absent sentinel for nothing', () => {
      expect(tokenOf(null)).toBe(ABSENT_TOKEN);
    });

    it('is stable and content-addressed', () => {
      expect(tokenOf('a')).toBe(tokenOf('a'));
      expect(tokenOf('a')).not.toBe(tokenOf('b'));
      expect(tokenOf('a')).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});
