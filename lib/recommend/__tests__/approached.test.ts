import { describe, expect, it } from 'vitest';

import { createApproachedStore } from '../approached';
import { createMemoryKvStore } from '../kv';
import { ROWS_TTL_MS } from '../outcome';
import type { TtlState } from '../kv';

const ITEM = '5029726254';
const GEN = 1;

const alive: TtlState = { kind: 'expires', ms: 60_000 };

function harness(now: () => number = () => 1_000) {
  const kv = createMemoryKvStore(now);
  return { kv, store: createApproachedStore(kv) };
}

const tick = (trainerItemId: string, approached = true, rowsTtl: TtlState = alive) => ({
  mondayItemId: ITEM,
  generation: GEN,
  trainerItemId,
  approached,
  rowsTtl,
});

describe('createApproachedStore', () => {
  it('returns nothing when nobody has been approached', async () => {
    const h = harness();
    expect(await h.store.read(ITEM, GEN, ['t1', 't2'])).toEqual(new Set());
  });

  it('round-trips a tick', async () => {
    const h = harness();
    await h.store.write(tick('t1'));

    expect(await h.store.read(ITEM, GEN, ['t1', 't2'])).toEqual(new Set(['t1']));
  });

  it('unticks by removing the mark', async () => {
    const h = harness();
    await h.store.write(tick('t1'));
    await h.store.write(tick('t1', false));

    expect(await h.store.read(ITEM, GEN, ['t1'])).toEqual(new Set());
  });

  it('unticking something that was never ticked is not an error', async () => {
    const h = harness();
    expect(await h.store.write(tick('t1', false))).toBe(true);
  });

  /**
   * One key per trainer, precisely so this works. A single JSON blob per list would make
   * two planners ticking two trainers a read-modify-write race, and one tick would
   * silently vanish.
   */
  it('keeps concurrent ticks for different trainers independent', async () => {
    const h = harness();

    await Promise.all([h.store.write(tick('t1')), h.store.write(tick('t2'))]);

    expect(await h.store.read(ITEM, GEN, ['t1', 't2'])).toEqual(new Set(['t1', 't2']));
  });

  it('scopes marks to the generation and the training', async () => {
    const h = harness();
    await h.store.write(tick('t1'));

    expect(await h.store.read(ITEM, GEN + 1, ['t1'])).toEqual(new Set());
    expect(await h.store.read('other-item', GEN, ['t1'])).toEqual(new Set());
  });

  describe('the borrowed lifetime', () => {
    /**
     * A mark annotates one stored list, so it expires with it. A fresh twelve months
     * would let a tick made in month eleven outlive its rows by nearly a year — and
     * since the key is generation-scoped, it would then sit there unreadable rather
     * than harmlessly.
     */
    it('expires with the rows it annotates, not twelve months later', async () => {
      const h = harness();
      await h.store.write(tick('t1', true, { kind: 'expires', ms: 5_000 }));

      expect(await h.kv.ttl(`approached:${ITEM}:${GEN}:t1`)).toEqual({
        kind: 'expires',
        ms: 5_000,
      });
    });

    it('really does lapse once the rows would have', async () => {
      let now = 1_000;
      const h = harness(() => now);
      await h.store.write(tick('t1', true, { kind: 'expires', ms: 5_000 }));

      now += 5_001;

      expect(await h.store.read(ITEM, GEN, ['t1'])).toEqual(new Set());
    });

    /**
     * Refused, not written. There is no list for the mark to annotate, and the route
     * turns this into an error the planner can act on rather than a tick that vanishes.
     */
    it('refuses a mark against rows that are already gone', async () => {
      const h = harness();

      expect(await h.store.write(tick('t1', true, { kind: 'absent' }))).toBe(false);
      expect(await h.store.read(ITEM, GEN, ['t1'])).toEqual(new Set());
    });

    /**
     * Cannot happen — the claim always sets a TTL on the rows — but "borrow forever" is
     * the one outcome not worth resting on an invariant, so it is bounded anyway.
     */
    it('bounds a mark even if the rows somehow have no expiry', async () => {
      const h = harness();
      await h.store.write(tick('t1', true, { kind: 'no-expiry' }));

      expect(await h.kv.ttl(`approached:${ITEM}:${GEN}:t1`)).toEqual({
        kind: 'expires',
        ms: ROWS_TTL_MS,
      });
    });
  });

  it('asks for nothing when the list is empty', async () => {
    const h = harness();
    expect(await h.store.read(ITEM, GEN, [])).toEqual(new Set());
  });
});
