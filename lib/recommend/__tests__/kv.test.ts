import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryKvStore, createRedisClient } from '../kv';

/**
 * Vercel's Upstash marketplace integration injects `KV_REST_API_*`, carried over from
 * when this was Vercel KV — not the `UPSTASH_REDIS_REST_*` names. Accepting both
 * avoids hand-duplicated variables that drift apart.
 */
describe('createRedisClient credentials', () => {
  const VARS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'KV_REST_API_READ_ONLY_TOKEN',
  ];

  afterEach(() => {
    for (const v of VARS) {
      delete process.env[v];
    }
  });

  it('accepts the Upstash names', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    expect(() => createRedisClient()).not.toThrow();
  });

  it("accepts Vercel's KV_REST_API_* aliases", () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    expect(() => createRedisClient()).not.toThrow();
  });

  /**
   * The read-only token authenticates but rejects writes. Falling back to it would
   * yield a client that reads fine and fails every enqueue — worse than not
   * connecting, because the failure looks like a queue bug rather than a config one.
   */
  it('does NOT fall back to the read-only token', () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_READ_ONLY_TOKEN = 'readonly';
    expect(() => createRedisClient()).toThrow(/Missing Redis credentials/);
  });

  it('treats a blank value as absent', () => {
    process.env.UPSTASH_REDIS_REST_URL = '  ';
    process.env.UPSTASH_REDIS_REST_TOKEN = '';
    expect(() => createRedisClient()).toThrow(/Missing Redis credentials/);
  });
});

/**
 * The in-memory `KvStore` is what every unit test in this pass runs against, so its
 * semantics have to match Redis exactly where the design depends on them: `NX`
 * (set-if-absent) decides the immutable-outcome winner, and the TTL-vs-no-TTL
 * distinction is what keeps a pending trigger record durable.
 */
describe('createMemoryKvStore', () => {
  it('returns null for an absent key and round-trips a value', async () => {
    const kv = createMemoryKvStore();
    expect(await kv.get('missing')).toBeNull();
    await kv.set('k', 'v');
    expect(await kv.get('k')).toBe('v');
  });

  it('setIfAbsent writes once and reports the winner', async () => {
    const kv = createMemoryKvStore();
    expect(await kv.setIfAbsent('k', 'first')).toBe(true);
    expect(await kv.setIfAbsent('k', 'second')).toBe(false);
    expect(await kv.get('k')).toBe('first');
  });

  it('incr allocates a strictly increasing sequence from 1', async () => {
    const kv = createMemoryKvStore();
    expect(await kv.incr('gen')).toBe(1);
    expect(await kv.incr('gen')).toBe(2);
    expect(await kv.incr('other')).toBe(1);
  });

  // A record written with no TTL must stay forever: a pending trigger that expired
  // would leave the pending index holding a bare uuid with no way to recover it.
  it('a key written without a TTL never expires', async () => {
    let now = 0;
    const kv = createMemoryKvStore(() => now);
    await kv.set('durable', 'v');
    expect(await kv.ttl('durable')).toEqual({ kind: 'no-expiry' });
    now = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(await kv.get('durable')).toBe('v');
  });

  it('a key written with a TTL expires on the injected clock', async () => {
    let now = 1_000;
    const kv = createMemoryKvStore(() => now);
    await kv.set('short', 'v', { ttlMs: 500 });
    expect(await kv.ttl('short')).toEqual({ kind: 'expires', ms: 500 });
    now = 1_499;
    expect(await kv.get('short')).toBe('v');
    now = 1_501;
    expect(await kv.get('short')).toBeNull();
    expect(await kv.ttl('short')).toEqual({ kind: 'absent' });
  });

  it('an expired key is absent for setIfAbsent, so a later writer wins', async () => {
    let now = 0;
    const kv = createMemoryKvStore(() => now);
    await kv.set('k', 'old', { ttlMs: 100 });
    now = 200;
    expect(await kv.setIfAbsent('k', 'new')).toBe(true);
    expect(await kv.get('k')).toBe('new');
  });

  /**
   * The positional contract is the whole point: the view zips these values back against
   * the trainer ids it asked about, so a compacted or reordered result would attribute
   * one trainer's `Benaderd` state to another.
   */
  describe('mget', () => {
    it('returns one value per key, in order, with null for the absent ones', async () => {
      const kv = createMemoryKvStore();
      await kv.set('a', '1');
      await kv.set('c', '3');

      expect(await kv.mget(['a', 'b', 'c'])).toEqual(['1', null, '3']);
    });

    it('answers an empty request with an empty list', async () => {
      // Normal, not exceptional: a training with no rows yet has no trainers to look up.
      expect(await createMemoryKvStore().mget([])).toEqual([]);
    });

    it('reports an expired key as absent, like get does', async () => {
      let now = 0;
      const kv = createMemoryKvStore(() => now);
      await kv.set('gone', 'v', { ttlMs: 100 });
      await kv.set('stays', 'v');
      now = 200;

      expect(await kv.mget(['gone', 'stays'])).toEqual([null, 'v']);
    });

    it('repeats a duplicated key rather than collapsing it', async () => {
      const kv = createMemoryKvStore();
      await kv.set('a', '1');
      expect(await kv.mget(['a', 'a'])).toEqual(['1', '1']);
    });
  });

  it('ttl distinguishes absent from no-expiry', async () => {
    const kv = createMemoryKvStore();
    expect(await kv.ttl('nope')).toEqual({ kind: 'absent' });
    await kv.set('k', 'v');
    expect(await kv.ttl('k')).toEqual({ kind: 'no-expiry' });
  });
});
