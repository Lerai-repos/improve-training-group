import { describe, expect, it } from 'vitest';

import { ASSIGNMENTS_TTL_MS, createCachedAssignments } from '../assignment-cache';
import { buildAgendaScan, countsFor } from '../assignments';
import { createMemoryKvStore } from '../kv';

const rows = [{ itemId: 'training-1', date: '2026-09-15', trainerItemIds: ['a'] }];
const scan = buildAgendaScan(rows);

const noSleep = (): Promise<void> => Promise.resolve();

function harness(load: () => Promise<typeof scan>) {
  const kv = createMemoryKvStore();
  return {
    kv,
    cache: createCachedAssignments({ kv, load, boardId: '5087396949', sleep: noSleep }),
  };
}

describe('createCachedAssignments', () => {
  it('scans once and serves the rest from cache', async () => {
    let scans = 0;
    const h = harness(() => {
      scans += 1;
      return Promise.resolve(scan);
    });

    await h.cache.read();
    const second = await h.cache.read();

    expect(scans).toBe(1);
    expect(countsFor(second.workload, 'a', '2026-09').thisMonth).toBe(1);
  });

  /**
   * Frozen clock. `ttl()` reports the time REMAINING, so on a real one a millisecond
   * between the write and the read makes this 299_999 — a test that fails once in a
   * while for no reason anyone can act on.
   */
  it('caches for five minutes, not forever', async () => {
    const kv = createMemoryKvStore(() => 1_000);
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      load: () => Promise.resolve(scan),
      sleep: noSleep,
    });
    await cache.read();

    expect(await kv.ttl('assignments:5087396949')).toEqual({
      kind: 'expires',
      ms: ASSIGNMENTS_TTL_MS,
    });
  });

  /**
   * The view polls every 20 seconds, so when the cache expires every open tab misses at
   * the same instant. Without single-flight they would all scan the board together —
   * the stampede the cache exists to prevent, concentrated into one second.
   */
  it('lets one caller scan while the others wait for its result', async () => {
    let scans = 0;
    let release: (() => void) | null = null;
    const kv = createMemoryKvStore();

    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      load: async () => {
        scans += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return scan;
      },
      // Standing in for a real delay: while the waiter sleeps, the holder finishes.
      sleep: () => {
        release?.();
        release = null;
        return Promise.resolve();
      },
    });

    const first = cache.read();
    await Promise.resolve();
    const second = cache.read();

    const [a, b] = await Promise.all([first, second]);

    // One scan, and BOTH callers got the same answer — the waiter did not fall back to
    // an empty index, which would read as "nobody is busy".
    expect(scans).toBe(1);
    expect(countsFor(a.workload, 'a', '2026-09').thisMonth).toBe(1);
    expect(countsFor(b.workload, 'a', '2026-09').thisMonth).toBe(1);
  });

  /**
   * Failure must travel. `readAssignmentIndex` fails closed on malformed Monday data
   * precisely so an empty index never reads as "nobody is busy" — caching that empty
   * index would reintroduce the same lie for five minutes.
   */
  it('propagates a failed scan, and never caches it as an empty index', async () => {
    const h = harness(() => Promise.reject(new Error('Agenda scan returned an unreadable page')));

    await expect(h.cache.read()).rejects.toThrow(/unreadable page/);
    // Something IS remembered — but as "unavailable", not as a scan with nobody in it.
    expect(await h.kv.get('assignments:5087396949')).not.toBeNull();
    await expect(h.cache.read()).rejects.toThrow(/unavailable/);
  });

  /**
   * Backoff. Without it, every open tab retries the same doomed scan every 20 seconds —
   * a steady drain on the Monday budget during an outage, and a six-second delay on
   * every view open, for two columns that cannot render anyway.
   */
  it('does not rescan while a recent failure is remembered', async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return Promise.reject(new Error('Monday down'));
    });

    await expect(h.cache.read()).rejects.toThrow('Monday down');
    await expect(h.cache.read()).rejects.toThrow(/unavailable/);

    expect(attempts).toBe(1);
  });

  /** The failure must expire, or one bad minute would cost the columns all day. */
  it('retries once the failure has aged out', async () => {
    let now = 1_000;
    let attempts = 0;
    const kv = createMemoryKvStore(() => now);
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      sleep: noSleep,
      load: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(scan);
      },
    });

    await expect(cache.read()).rejects.toThrow('boom');
    now += 31_000;

    await expect(cache.read()).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it('gives up rather than starting a second scan when the holder never finishes', async () => {
    const kv = createMemoryKvStore();
    // Someone else holds the lock and will never write a result.
    await kv.setIfAbsent('assignments-lock:5087396949', '1', { ttlMs: 30_000 });
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      load: () => Promise.reject(new Error('must not be called')),
      sleep: noSleep,
    });

    await expect(cache.read()).rejects.toThrow(/did not finish/);
  });

  /**
   * A scan that outlives the 30s lease lets someone else take a fresh lock. Releasing
   * unconditionally would free THEIRS, re-opening the stampede this exists to prevent.
   */
  it('does not release a lock another refresh now owns', async () => {
    const kv = createMemoryKvStore();
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      token: () => 'mine',
      sleep: noSleep,
      load: async () => {
        // While we scan, our lease expires and someone else takes the lock.
        await kv.del('assignments-lock:5087396949');
        await kv.setIfAbsent('assignments-lock:5087396949', 'theirs', { ttlMs: 30_000 });
        return scan;
      },
    });

    await cache.read();

    expect(await kv.get('assignments-lock:5087396949')).toBe('theirs');
  });

  /**
   * The Agenda board always has some undated training, and `monthByItemId` records those
   * as null deliberately. A schema that rejected them would fail the WHOLE entry on every
   * read — a permanent cache miss, rescanning Monday each time.
   */
  it('round-trips a board containing undated trainings', async () => {
    let scans = 0;
    const withUndated = buildAgendaScan([
      { itemId: 'dated', date: '2026-09-15', trainerItemIds: ['a'] },
      { itemId: 'undated', date: null, trainerItemIds: ['a'] },
    ]);
    const h = harness(() => {
      scans += 1;
      return Promise.resolve(withUndated);
    });

    await h.cache.read();
    const second = await h.cache.read();

    expect(scans).toBe(1);
    expect(second.monthByItemId.get('undated')).toBeNull();
    expect(second.monthByItemId.has('undated')).toBe(true);
    expect(second.monthByItemId.get('dated')).toBe('2026-09');
  });

  /** A waiter must recognise the holder's failure, not poll out the full wait for it. */
  it('stops waiting as soon as the holder reports failure', async () => {
    const kv = createMemoryKvStore();
    let sleeps = 0;
    let release: (() => void) | null = null;

    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error('Monday down');
      },
      sleep: () => {
        sleeps += 1;
        release?.();
        release = null;
        return Promise.resolve();
      },
    });

    const holder = cache.read();
    await Promise.resolve();
    const waiter = cache.read();

    await expect(holder).rejects.toThrow('Monday down');
    await expect(waiter).rejects.toThrow(/in front of us failed/);
    // A couple of polls, not the full twelve: the waiter sees the sentinel as soon as
    // the holder writes it, rather than waiting out three seconds for a result that is
    // never coming. (Two, not one — the holder writes its sentinel just after the
    // release resolves, so the waiter needs one more look.)
    expect(sleeps).toBeLessThanOrEqual(3);
  });

  it('ignores a corrupt cache entry rather than serving nonsense', async () => {
    let scans = 0;
    const h = harness(() => {
      scans += 1;
      return Promise.resolve(scan);
    });
    await h.kv.set('assignments:5087396949', '{not json');

    await h.cache.read();

    expect(scans).toBe(1);
  });
});
