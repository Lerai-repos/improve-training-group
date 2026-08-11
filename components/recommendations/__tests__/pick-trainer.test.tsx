import { describe, expect, it, vi } from 'vitest';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { pickTrainer } from '../pick-trainer';
import { fakeMonday, noWhatsapp, readyView, row } from './fakes';

import type { RecommendationsApi } from '../api';
import type { RecommendationView } from '../types';

const BOARD = '5087396949';
const ITEM = '5029726254';
const TRAINER = '900';

const at = (generation: number): RecommendationView => ({
  ...readyView([row({ trainerItemId: TRAINER })]),
  state: { kind: 'ready', generation, rows: [row({ trainerItemId: TRAINER })] },
});

/** Answers each successive `get` from the script, so a mid-write change is expressible. */
function apiReturning(generations: number[]): RecommendationsApi {
  let index = 0;
  return {
    get() {
      const generation = generations[Math.min(index, generations.length - 1)];
      index += 1;
      return Promise.resolve(at(generation));
    },
    recalculate: () => Promise.resolve(),
      ...noWhatsapp(),
    setApproached: () => Promise.resolve(),
  };
}

const pick = { mondayItemId: ITEM, generation: 1, trainerItemId: TRAINER };

describe('pickTrainer', () => {
  it('writes the relation as the logged-in user and reports success', async () => {
    const monday = fakeMonday();
    const api = apiReturning([1, 1]);
    const apiSpy = vi.spyOn(monday, 'api');

    expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toEqual({ kind: 'linked' });

    const [, variables] = apiSpy.mock.calls[0];
    expect(variables).toMatchObject({
      boardId: BOARD,
      itemId: ITEM,
      columnId: AGENDA_2026_COLUMNS.trainerRelation,
    });
    // A board relation takes JSON-encoded ids, not an array.
    expect(variables?.value).toBe(JSON.stringify({ item_ids: [900] }));
  });

  /**
   * The complete half of the promise: a change we can SEE before writing is refused, and
   * nothing happens at all.
   */
  it('refuses before writing when the list has already moved', async () => {
    const monday = fakeMonday();
    const apiSpy = vi.spyOn(monday, 'api');

    const outcome = await pickTrainer({ monday, api: apiReturning([2]), boardId: BOARD }, pick);

    expect(outcome).toEqual({ kind: 'refused', generation: 2 });
    expect(apiSpy).not.toHaveBeenCalled();
  });

  /**
   * The bounded half. Monday has no conditional relation mutation, so no client-side
   * check can be atomic with the write — a recalculate landing DURING it is detected
   * afterwards and surfaced. It is not undone: reversing a planner's write would be
   * worse than the staleness.
   */
  it('reports a change that landed during the write, naming the trainer', async () => {
    const monday = fakeMonday();
    const apiSpy = vi.spyOn(monday, 'api');

    const outcome = await pickTrainer({ monday, api: apiReturning([1, 2]), boardId: BOARD }, pick);

    expect(outcome).toEqual({ kind: 'linked_but_stale', trainerItemId: TRAINER });
    // The relation WAS written — that is the whole point of the warning.
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a failed write rather than claiming success', async () => {
    const monday = fakeMonday();
    vi.spyOn(monday, 'api').mockRejectedValue(new Error('Column not editable'));

    const outcome = await pickTrainer({ monday, api: apiReturning([1, 1]), boardId: BOARD }, pick);

    // Monday's own permissions are the real gate; a refusal must read as one.
    expect(outcome).toEqual({ kind: 'failed', message: 'Column not editable' });
  });

  /**
   * The relation IS set. Reporting a post-write read failure as a failed pick would tell
   * the planner nothing happened when something did — and they would pick again,
   * overwriting a correct link or adding a second trainer.
   */
  it('reports a write it could not verify as linked, not as failed', async () => {
    const monday = fakeMonday();
    let reads = 0;
    const api: RecommendationsApi = {
      get() {
        reads += 1;
        return reads === 1 ? Promise.resolve(at(1)) : Promise.reject(new Error('Redis unreachable'));
      },
      recalculate: () => Promise.resolve(),
      ...noWhatsapp(),
      setApproached: () => Promise.resolve(),
    };

    const outcome = await pickTrainer({ monday, api, boardId: BOARD }, pick);

    expect(outcome).toMatchObject({ kind: 'linked_unverified', trainerItemId: TRAINER });
  });

  /** Before the write, a read failure IS a plain failure — nothing has happened yet. */
  it('reports a pre-write read failure as failed, having written nothing', async () => {
    const monday = fakeMonday();
    const apiSpy = vi.spyOn(monday, 'api');
    const api: RecommendationsApi = {
      get: () => Promise.reject(new Error('Redis unreachable')),
      recalculate: () => Promise.resolve(),
      ...noWhatsapp(),
      setApproached: () => Promise.resolve(),
    };

    expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toEqual({
      kind: 'failed',
      message: 'Redis unreachable',
    });
    expect(apiSpy).not.toHaveBeenCalled();
  });

  /**
   * A generation number alone is not the question. The SAME generation can come back
   * `unavailable` once the rows expire, and a `ready` list can be rebuilt without this
   * trainer — both would pass a numeric comparison while the thing being linked is no
   * longer something the engine stands behind.
   */
  describe('validating the list, not just its number', () => {
    const viewOf = (state: RecommendationView['state']): RecommendationView => ({
      state,
      caps: { canPlan: true, canViewFull: true },
    });

    const answering = (views: RecommendationView[]): RecommendationsApi => {
      let index = 0;
      return {
        get() {
          const view = views[Math.min(index, views.length - 1)];
          index += 1;
          return Promise.resolve(view);
        },
        recalculate: () => Promise.resolve(),
      ...noWhatsapp(),
        setApproached: () => Promise.resolve(),
      };
    };

    it('refuses a same-generation list whose rows have expired', async () => {
      const monday = fakeMonday();
      const apiSpy = vi.spyOn(monday, 'api');
      const api = answering([viewOf({ kind: 'unavailable', generation: 1, label: 'GEREED' })]);

      expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toMatchObject({
        kind: 'refused',
      });
      expect(apiSpy).not.toHaveBeenCalled();
    });

    it('refuses when the trainer is no longer on the list', async () => {
      const monday = fakeMonday();
      const apiSpy = vi.spyOn(monday, 'api');
      const api = answering([
        viewOf({ kind: 'ready', generation: 1, rows: [row({ trainerItemId: 'someone-else' })] }),
      ]);

      expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toMatchObject({
        kind: 'refused',
      });
      expect(apiSpy).not.toHaveBeenCalled();
    });

    it('treats a post-write list that lost the trainer as stale', async () => {
      const monday = fakeMonday();
      const api = answering([
        viewOf({ kind: 'ready', generation: 1, rows: [row({ trainerItemId: TRAINER })] }),
        viewOf({ kind: 'ready', generation: 1, rows: [row({ trainerItemId: 'someone-else' })] }),
      ]);

      expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toEqual({
        kind: 'linked_but_stale',
        trainerItemId: TRAINER,
      });
    });

    it('treats a post-write list that expired as stale', async () => {
      const monday = fakeMonday();
      const api = answering([
        viewOf({ kind: 'ready', generation: 1, rows: [row({ trainerItemId: TRAINER })] }),
        viewOf({ kind: 'unavailable', generation: 1, label: 'GEREED' }),
      ]);

      expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toMatchObject({
        kind: 'linked_but_stale',
      });
    });
  });

  it('treats a training with no generation as moved', async () => {
    const monday = fakeMonday();
    const api: RecommendationsApi = {
      get: () =>
        Promise.resolve({ state: { kind: 'idle' }, caps: { canPlan: true, canViewFull: true } }),
      recalculate: () => Promise.resolve(),
      ...noWhatsapp(),
      setApproached: () => Promise.resolve(),
    };

    expect(await pickTrainer({ monday, api, boardId: BOARD }, pick)).toEqual({
      kind: 'refused',
      generation: 0,
    });
  });
});
