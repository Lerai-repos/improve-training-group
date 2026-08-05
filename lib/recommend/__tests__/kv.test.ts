import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';

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

  it('ttl distinguishes absent from no-expiry', async () => {
    const kv = createMemoryKvStore();
    expect(await kv.ttl('nope')).toEqual({ kind: 'absent' });
    await kv.set('k', 'v');
    expect(await kv.ttl('k')).toEqual({ kind: 'no-expiry' });
  });
});
