import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASSIGNMENTS_TTL_MS, createCachedAssignments } from '../assignment-cache';
import { WORKLOAD_CRON_DEADLINE_MS } from '../deps';
import { buildAgendaScan, countsFor } from '../assignments';
import { createMemoryKvStore } from '../kv';

const rows = [{ itemId: 'training-1', date: '2026-09-15', trainerItemIds: ['a'] }];
const scan = buildAgendaScan(rows);

const noSleep = (): Promise<void> => Promise.resolve();

/** The cache's own on-disk shape, so a test can plant a result the way a holder would. */
const encoded = (value: typeof scan): string =>
  JSON.stringify({
    workload: [...value.workload].map(([trainer, months]) => [trainer, [...months]]),
    months: [...value.monthByItemId],
  });

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
  it('caches for its TTL, not forever', async () => {
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

/**
 * The scheduled refresh — what keeps "opdrachten deze maand" and "opdrachten dit jaar"
 * filled. Everything here is about one property: a background run may never make the
 * columns worse than it found them.
 */
describe('the workload refresh', () => {
  const other = buildAgendaScan([
    { itemId: 'training-2', date: '2026-09-20', trainerItemIds: ['a'] },
    { itemId: 'training-3', date: '2026-09-21', trainerItemIds: ['a'] },
  ]);

  it('fills an empty cache', async () => {
    const h = harness(() => Promise.resolve(scan));

    expect(await h.cache.peek()).toEqual({ kind: 'miss' });
    expect(await h.cache.refresh()).toEqual({ refreshed: true });

    const peeked = await h.cache.peek();
    expect(peeked.kind).toBe('hit');
    expect(peeked.kind === 'hit' && countsFor(peeked.value.workload, 'a', '2026-09').thisMonth).toBe(
      1
    );
  });

  it('replaces a cached scan with the newer one', async () => {
    let current = scan;
    const h = harness(() => Promise.resolve(current));
    await h.cache.refresh();

    current = other;
    await h.cache.refresh();

    const peeked = await h.cache.peek();
    expect(peeked.kind === 'hit' && countsFor(peeked.value.workload, 'a', '2026-09').thisMonth).toBe(
      2
    );
  });

  /**
   * THE reason `refresh` is not just `read` on an expired key.
   *
   * A scheduled run happens while a perfectly good scan is still cached. Recording the
   * failure the way `read` does would replace that scan with the unavailable sentinel and
   * blank both columns — for a run nobody asked for and nobody was waiting on. Fifteen
   * minutes of TTL over a five-minute schedule only helps if a failed run is a no-op.
   */
  it('leaves a cached scan untouched when the rescan fails', async () => {
    let fail = false;
    const h = harness(() => (fail ? Promise.reject(new Error('Monday down')) : Promise.resolve(scan)));
    await h.cache.refresh();

    fail = true;
    await expect(h.cache.refresh()).rejects.toThrow('Monday down');

    const peeked = await h.cache.peek();
    expect(peeked.kind).toBe('hit');
    // And the value is still readable, i.e. no sentinel was written over it.
    expect(countsFor((await h.cache.read()).workload, 'a', '2026-09').thisMonth).toBe(1);
  });

  /**
   * The mirror image, and the rule is about what there was to lose.
   *
   * With nothing cached a failure has to be recorded. A miss is what makes the view
   * schedule a refresh, so a silent cold failure turns an outage into a fresh board scan
   * on every 20-second poll from every open tab — the stampede `failureTtlMs` exists to
   * stop, and it would never be reached.
   */
  it('records a failure when there was nothing cached to protect', async () => {
    const h = harness(() => Promise.reject(new Error('Monday down')));

    await expect(h.cache.refresh()).rejects.toThrow('Monday down');

    expect(await h.cache.peek()).toEqual({ kind: 'failed' });
  });

  /**
   * The sentinel must hold off the VIEW, never the cron.
   *
   * `refresh` ignores what is cached by design, so a failure it recorded cannot stop the
   * next scheduled run five minutes later. If it could, one unreachable moment would park
   * the columns until somebody noticed — the opposite of what the sentinel is for.
   */
  it('still runs on schedule after recording a failure of its own', async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('Monday down')) : Promise.resolve(scan);
    });

    await expect(h.cache.refresh()).rejects.toThrow('Monday down');
    expect(await h.cache.peek()).toEqual({ kind: 'failed' });

    await expect(h.cache.refresh()).resolves.toEqual({ refreshed: true });

    expect(attempts).toBe(2);
    expect((await h.cache.peek()).kind).toBe('hit');
  });

  it('remembers a cold failure only briefly, never for the data TTL', async () => {
    const kv = createMemoryKvStore(() => 1_000);
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      load: () => Promise.reject(new Error('Monday down')),
      sleep: noSleep,
    });

    await expect(cache.refresh()).rejects.toThrow('Monday down');

    const ttl = await kv.ttl('assignments:5087396949');
    expect(ttl.kind).toBe('expires');
    expect(ttl.kind === 'expires' && ttl.ms).toBeLessThan(ASSIGNMENTS_TTL_MS);
  });

  /**
   * A lease shorter than the scan is not a lock. The cron budgets sixty seconds, so a
   * thirty-second default would lapse mid-scan and let the next caller start a second
   * scan of the same board — duplicate work, arriving exactly when the scan is slow.
   */
  it('holds the lock for longer than the scan is allowed to take', async () => {
    const kv = createMemoryKvStore(() => 1_000);
    let held: number | null = null;
    const cache = createCachedAssignments({
      kv,
      boardId: '5087396949',
      lockTtlMs: WORKLOAD_CRON_DEADLINE_MS + 15_000,
      load: async () => {
        const ttl = await kv.ttl('assignments-lock:5087396949');
        held = ttl.kind === 'expires' ? ttl.ms : null;
        return scan;
      },
      sleep: noSleep,
    });

    await cache.refresh();

    expect(held).not.toBeNull();
    expect(held ?? 0).toBeGreaterThan(WORKLOAD_CRON_DEADLINE_MS);
  });

  /**
   * Two runs overlapping — a slow scan and the next five-minute tick, or a request that
   * missed at the same moment. The second must not scan the board again; the first one's
   * result lands in the same key.
   */
  it('skips the scan entirely when another refresh holds the lock', async () => {
    let scans = 0;
    const h = harness(() => {
      scans += 1;
      return Promise.resolve(scan);
    });
    await h.kv.set('assignments-lock:5087396949', 'someone-else');

    // `contended`, not `locked`: without `awaitContended` nobody looked at the cache, so
    // the only honest claim is that somebody else holds the lock.
    expect(await h.cache.refresh()).toEqual({ refreshed: false, reason: 'contended' });
    expect(scans).toBe(0);
  });

  /**
   * The scheduled run's whole job is that a scan exists afterwards, and a held lock does
   * not promise that.
   *
   * The likeliest holder is a planner's own warm-up on the request path, which budgets
   * six seconds against a scan that needs eight. Treating `locked` as success would let
   * that warm-up time out and leave both columns blank for another five minutes while the
   * cron reported 200 — the original bug, wearing a different hat.
   */
  describe('when another refresh holds the lock', () => {
    /**
     * THE case this option exists for, at the timing that actually occurs.
     *
     * The request-path warm-up holds the lock for its own six-second deadline and then
     * fails. A wait shorter than that reports `locked` while the cache is still empty —
     * which is the original blank-columns bug, now inside the mechanism meant to prevent
     * it. The wait therefore has to outlast the holder, not merely exceed a typical scan.
     */
    it('outlasts a holder that fails later than the old wait would have allowed', async () => {
      let scans = 0;
      const kv = createMemoryKvStore();
      /**
       * Comfortably past the twelve turns the old three-second wait allowed, so this
       * fails against that version rather than passing on both. The bound now comes from
       * the lock's lease, which is minutes rather than seconds.
       */
      const HOLDER_GIVES_UP_AFTER = 20;
      let turns = 0;
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => {
          scans += 1;
          return Promise.resolve(scan);
        },
        sleep: async () => {
          turns += 1;
          if (turns === HOLDER_GIVES_UP_AFTER) {
            // The warm-up's deadline expires: it records its cold failure, then releases.
            await kv.set('assignments:5087396949', '"unavailable"', { ttlMs: 30_000 });
            await kv.del('assignments-lock:5087396949');
          }
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'warm-up', { ttlMs: 30_000 });

      const outcome = await cache.refresh({ awaitContended: true });

      expect(outcome).toEqual({ refreshed: true });
      expect(scans).toBe(1);
      expect(turns).toBeGreaterThan(12);
      expect((await cache.peek()).kind).toBe('hit');
    });

    /**
     * The same scenario with the wait cut short, which is what the code did before: it
     * stops while the holder is still running, and the cache is left empty behind a
     * cheerful "somebody else has it". Kept as a test so the length of that wait stays a
     * decision rather than an accident.
     */
    it('would report contended if it gave up before the holder did', async () => {
      const kv = createMemoryKvStore();
      let turns = 0;
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => Promise.resolve(scan),
        sleep: async () => {
          turns += 1;
          if (turns === 20) {
            await kv.del('assignments-lock:5087396949');
          }
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'warm-up', { ttlMs: 300_000 });

      const outcome = await cache.refresh({ awaitContended: true, contendedWaitMs: 3_000 });

      expect(outcome).toEqual({ refreshed: false, reason: 'contended' });
      expect((await cache.peek()).kind).toBe('miss');
    });

    /**
     * The sentinel and the lock release are two separate writes, so there is a window in
     * which a failed holder has recorded its failure but not yet let go. A waiter that
     * read that as "somebody is working on it" would stop one turn early — the race the
     * review called out — so only a decodable value may end the wait.
     */
    it('does not mistake the failure sentinel for the holder still working', async () => {
      let scans = 0;
      const kv = createMemoryKvStore();
      let turns = 0;
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => {
          scans += 1;
          return Promise.resolve(scan);
        },
        sleep: async () => {
          turns += 1;
          // Sentinel first, lock released only a turn later — the gap that matters.
          if (turns === 2) {
            await kv.set('assignments:5087396949', '"unavailable"', { ttlMs: 30_000 });
          }
          if (turns === 4) {
            await kv.del('assignments-lock:5087396949');
          }
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'warm-up', { ttlMs: 30_000 });

      const outcome = await cache.refresh({ awaitContended: true });

      expect(outcome).toEqual({ refreshed: true });
      expect(scans).toBe(1);
    });

    /**
     * A holder that never lets go is reported as `contended`, NOT as `locked`.
     *
     * The distinction is the whole point: `locked` claims a usable value is cached, and
     * claiming that without having seen one is how a cron reports 200 over empty columns.
     */
    it('reports contended, not locked, when it never saw a value', async () => {
      let scans = 0;
      const h = harness(() => {
        scans += 1;
        return Promise.resolve(scan);
      });
      // A holder that took the lock and will never write a result nor release it.
      await h.kv.setIfAbsent('assignments-lock:5087396949', 'someone-else', { ttlMs: 300_000 });

      const outcome = await h.cache.refresh({ awaitContended: true });

      expect(outcome).toEqual({ refreshed: false, reason: 'contended' });
      expect(scans).toBe(0);
      expect(await h.kv.get('assignments-lock:5087396949')).toBe('someone-else');
    });

    /** The holder failed and released: nobody else is coming, so the cron does it itself. */
    it('scans itself once the holder has failed and let go', async () => {
      let scans = 0;
      const kv = createMemoryKvStore();
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => {
          scans += 1;
          return Promise.resolve(scan);
        },
        // While we wait, the holder records its failure and releases the lock.
        sleep: async () => {
          await kv.set('assignments:5087396949', '"unavailable"', { ttlMs: 30_000 });
          await kv.del('assignments-lock:5087396949');
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'someone-else', { ttlMs: 30_000 });

      const outcome = await cache.refresh({ awaitContended: true });

      expect(outcome).toEqual({ refreshed: true });
      expect(scans).toBe(1);
      // And the sentinel the failed holder left behind is replaced by a real scan.
      expect((await cache.peek()).kind).toBe('hit');
    });

    /** A holder that succeeds is simply believed — no second scan of the same board. */
    it('accepts the holder’s result rather than scanning again', async () => {
      let scans = 0;
      const kv = createMemoryKvStore();
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => {
          scans += 1;
          return Promise.resolve(scan);
        },
        sleep: async () => {
          await kv.set('assignments:5087396949', encoded(scan), { ttlMs: 60_000 });
          await kv.del('assignments-lock:5087396949');
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'someone-else', { ttlMs: 30_000 });

      const outcome = await cache.refresh({ awaitContended: true });

      expect(outcome).toEqual({ refreshed: false, reason: 'locked' });
      expect(scans).toBe(0);
    });

    /**
     * Without the flag the behaviour is unchanged: a caller with a user waiting must not
     * sit in a poll loop on the request path.
     */
    it('does not wait at all unless the caller asked to', async () => {
      let slept = 0;
      const kv = createMemoryKvStore();
      const cache = createCachedAssignments({
        kv,
        boardId: '5087396949',
        load: () => Promise.resolve(scan),
        sleep: () => {
          slept += 1;
          return Promise.resolve();
        },
      });
      await kv.setIfAbsent('assignments-lock:5087396949', 'someone-else', { ttlMs: 30_000 });

      expect(await cache.refresh()).toEqual({ refreshed: false, reason: 'contended' });
      expect(slept).toBe(0);
    });
  });

  it('releases the lock so the next run can take it', async () => {
    const h = harness(() => Promise.resolve(scan));

    await h.cache.refresh();

    expect(await h.kv.get('assignments-lock:5087396949')).toBeNull();
  });

  /** A rejected scan must not leave the lock behind, or every later run reports `locked`. */
  it('releases the lock after a failed rescan too', async () => {
    const h = harness(() => Promise.reject(new Error('Monday down')));

    await expect(h.cache.refresh()).rejects.toThrow('Monday down');

    expect(await h.kv.get('assignments-lock:5087396949')).toBeNull();
  });

  it('reports a remembered failure as failed, not as a miss', async () => {
    const h = harness(() => Promise.reject(new Error('Monday down')));
    await expect(h.cache.read()).rejects.toThrow('Monday down');

    // `read` — unlike `refresh` — does write the sentinel, and `peek` must keep it legible
    // so the view can tell "not scanned yet" from "just tried and could not".
    expect(await h.cache.peek()).toEqual({ kind: 'failed' });
  });

  /**
   * The guard on the whole fix. If the TTL ever drops to or below the cron interval, a
   * single slow or failed run empties the columns again — the exact bug ITG reported,
   * reintroduced by a one-line change that looks harmless.
   */
  it('outlives the refresh schedule in vercel.json', () => {
    const config: { crons?: { path: string; schedule: string }[] } = JSON.parse(
      readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
    );
    const cron = config.crons?.find((entry) => entry.path === '/api/cron/refresh-workload');
    expect(cron, 'the refresh cron must be scheduled').toBeDefined();

    const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron?.schedule ?? '');
    expect(minutes, `unexpected schedule ${cron?.schedule}`).not.toBeNull();

    const intervalMs = Number(minutes?.[1]) * 60 * 1000;
    /**
     * Three intervals is not three chances: a value written at T0 with a life of exactly
     * three intervals expires *as* the third run starts, and that run still needs its
     * 5.5–8.5 seconds. So the TTL must clear three intervals plus room for the scan
     * itself, or two failures can still leave a gap the third success does not close.
     */
    const SLOWEST_SCAN_MS = 10_000;
    expect(ASSIGNMENTS_TTL_MS).toBeGreaterThan(intervalMs * 3 + SLOWEST_SCAN_MS);
  });
});
