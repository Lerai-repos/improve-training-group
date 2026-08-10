import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api';
import { useRecommendationView } from '../use-recommendation-view';
import { fakeApi, fakeMonday, readyView, row } from './fakes';

import type { RecommendationView } from '../types';

afterEach(cleanup);

const COMPUTING: RecommendationView = {
  state: { kind: 'computing', generation: 1 },
  caps: { canPlan: true, canViewFull: true },
};

const READY = readyView([row()]);

const BOARD = '5087396949';

describe('useRecommendationView', () => {
  it('loads the item from the Monday context', async () => {
    const monday = fakeMonday({ itemId: '5029726254', boardId: BOARD, theme: 'light' });
    const api = fakeApi([READY]);

    const { result } = renderHook(() => useRecommendationView(monday, api));

    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.itemId).toBe('5029726254');
  });

  /**
   * The answer arrives from a queue, not from this request, so the view has to ask again
   * while it waits — then drop to a slow cadence once it settles. It does not stop
   * entirely: a `ready` list is shared state that other planners keep changing.
   */
  it('polls quickly while computing, then backs off once an answer lands', async () => {
    const monday = fakeMonday();
    const api = fakeApi([COMPUTING, COMPUTING, READY]);

    const { result } = renderHook(() =>
      useRecommendationView(monday, api, {
        pollIntervalMs: 5,
        readyPollIntervalMs: 10_000,
      })
    );

    await waitFor(() => {
      expect(result.current.status).toMatchObject({ kind: 'loaded', view: READY });
    });

    // Several fast polls got us here…
    expect(api.gets).toBeGreaterThanOrEqual(3);

    // …and now nothing more for a long while.
    const settled = api.gets;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(api.gets).toBe(settled);
  });

  /** The slow cadence still runs — a colleague's tick must eventually show up. */
  it('keeps refreshing a settled list', async () => {
    const monday = fakeMonday();
    const api = fakeApi([READY]);

    renderHook(() =>
      useRecommendationView(monday, api, { readyPollIntervalMs: 5 })
    );

    await waitFor(() => {
      expect(api.gets).toBeGreaterThan(2);
    });
  });

  /**
   * The iframe is NOT remounted when a planner clicks the next training — only the
   * context changes. Everything scoped to the old item has to go with it, or the new
   * training inherits the previous one's state.
   */
  it('reloads and clears state when the item changes underneath it', async () => {
    const monday = fakeMonday({ itemId: '111', boardId: BOARD, theme: 'light' });
    const api = fakeApi([READY]);

    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      monday.changeContext({ itemId: '222', boardId: BOARD, theme: 'dark' });
    });

    await waitFor(() => {
      expect(result.current.itemId).toBe('222');
    });
    expect(result.current.theme).toBe('dark');
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
  });

  describe('recalculate', () => {
    it('sends one action id and refreshes', async () => {
      const monday = fakeMonday();
      const api = fakeApi([READY]);
      const { result } = renderHook(() => useRecommendationView(monday, api));
      await waitFor(() => {
        expect(result.current.status.kind).toBe('loaded');
      });

      await act(async () => {
        await result.current.recalculate();
      });

      expect(api.recalculates).toHaveLength(1);
      expect(api.recalculates[0]).toMatch(/^[A-Za-z0-9]{8,64}$/);
    });

    /**
     * A deliberate second press is new work and must get a new id — reusing one would
     * be answered as a duplicate and the planner's second request would vanish.
     */
    it('mints a new id for each deliberate press', async () => {
      const monday = fakeMonday();
      const api = fakeApi([READY]);
      const { result } = renderHook(() => useRecommendationView(monday, api));
      await waitFor(() => {
        expect(result.current.status.kind).toBe('loaded');
      });

      await act(async () => {
        await result.current.recalculate();
      });
      await act(async () => {
        await result.current.recalculate();
      });

      expect(new Set(api.recalculates).size).toBe(2);
    });
  });

  it('marks a trainer against the generation currently on screen', async () => {
    const monday = fakeMonday();
    const api = fakeApi([readyView([row({ trainerItemId: '900' })])]);
    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    await act(async () => {
      await result.current.setApproached('900', true);
    });

    expect(api.approached).toEqual([{ generation: 1, trainerItemId: '900', approached: true }]);
  });

  /**
   * The guard `AbortSignal` cannot provide. `setApproached` and `recalculate` call
   * `load()` with no signal, so an action started on training A can finish after the
   * planner has moved to B and write A's list into B's view.
   */
  it('discards a mutation’s reload when the item changed while it was in flight', async () => {
    const monday = fakeMonday({ itemId: '111', boardId: BOARD, theme: 'light' });
    const forA = readyView([row({ trainerItemId: 'from-A' })]);
    const forB = readyView([row({ trainerItemId: 'from-B' })]);

    let release: (() => void) | null = null;
    const api = {
      ...fakeApi([forA]),
      get: (itemId: string) =>
        itemId === '111'
          ? new Promise<typeof forA>((resolve) => {
              release = () => {
                resolve(forA);
              };
            })
          : Promise.resolve(forB),
      setApproached: () => Promise.resolve(),
    };

    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.itemId).toBe('111');
    });

    // A's load is parked; switch to B before letting it finish.
    act(() => {
      monday.changeContext({ itemId: '222', boardId: BOARD, theme: 'light' });
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('222');
    });
    await waitFor(() => {
      expect(result.current.status).toMatchObject({ kind: 'loaded', view: forB });
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    // B's list survives — A's late answer is dropped, not rendered.
    expect(result.current.status).toMatchObject({ kind: 'loaded', view: forB });
  });

  /**
   * Nothing clears `stale` on its own — the list really is superseded until something
   * replaces it — so without an explicit recovery the controls stay frozen while the
   * warning tells the planner to refresh.
   */
  it('offers a way out of a frozen list', async () => {
    const monday = fakeMonday();
    const api = {
      ...fakeApi([READY]),
      setApproached: () => Promise.reject(new ApiError(409, 'generation 1 is stale')),
    };
    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    await act(async () => {
      await result.current.setApproached('900', true);
    });
    expect(result.current.stale).toBe(true);

    await act(async () => {
      await result.current.reset();
    });

    expect(result.current.stale).toBe(false);
    expect(result.current.warning).toBeNull();
  });

  /**
   * Unfreezing before the replacement arrives would re-enable the controls over the very
   * rows just declared superseded — and a failed reload would leave them enabled with
   * nothing replaced.
   */
  it('stays frozen when the recovery reload fails', async () => {
    const monday = fakeMonday();
    let allowGet = true;
    const api = {
      ...fakeApi([READY]),
      get: () => (allowGet ? Promise.resolve(READY) : Promise.reject(new Error('still down'))),
      setApproached: () => Promise.reject(new ApiError(409, 'generation 1 is stale')),
    };
    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    await act(async () => {
      await result.current.setApproached('900', true);
    });
    expect(result.current.stale).toBe(true);

    allowGet = false;
    await act(async () => {
      await result.current.reset();
    });

    expect(result.current.stale).toBe(true);
  });

  /**
   * `unknown` is not an empty relation. Before the first successful read — or after one
   * fails — a colleague may already have chosen, and picking would overwrite them.
   */
  it('refuses to pick while the trainer relation is unknown', async () => {
    const monday = fakeMonday();
    const apiSpy = vi.spyOn(monday, 'api').mockRejectedValue(new Error('viewers cannot call us'));
    const api = fakeApi([readyView([row({ trainerItemId: '900' })])]);

    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.linked.kind).toBe('error');
    });

    await act(async () => {
      await result.current.pick('900');
    });

    // Only the failed relation reads — never a mutation.
    expect(apiSpy.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true);
  });

  it('reports the linked trainer once Monday answers', async () => {
    const monday = fakeMonday();
    const api = fakeApi([readyView([row({ trainerItemId: '900' })])]);

    const { result } = renderHook(() => useRecommendationView(monday, api));

    await waitFor(() => {
      expect(result.current.linked).toMatchObject({ kind: 'ready' });
    });
  });

  /**
   * One generation-sensitive action at a time: a recalculate landing between a pick's
   * before- and after-checks would let both pass while the trainer came from the
   * superseded list.
   */
  it('reports a single busy flag covering every mutation', async () => {
    const monday = fakeMonday();
    const api = fakeApi([READY]);
    const { result } = renderHook(() => useRecommendationView(monday, api));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    expect(result.current.busy).toBe(false);
  });

  /**
   * `context()` is a promise and `listen('context')` is a callback, so a planner who
   * clicks the next training while the first read is still in flight would be dragged
   * back to the previous one by the late resolution.
   */
  it('does not let a late initial context override a change that already arrived', async () => {
    let resolveInitial: ((context: { itemId: string; boardId: string; theme: 'light' }) => void) | null =
      null;
    const monday = fakeMonday();
    monday.context = () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      });

    const api = fakeApi([READY]);
    const { result } = renderHook(() => useRecommendationView(monday, api));

    act(() => {
      monday.changeContext({ itemId: '222', boardId: BOARD, theme: 'light' });
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('222');
    });

    await act(async () => {
      resolveInitial?.({ itemId: '111', boardId: BOARD, theme: 'light' });
      await Promise.resolve();
    });

    expect(result.current.itemId).toBe('222');
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    const monday = fakeMonday();
    const api = {
      ...fakeApi([READY]),
      get: () => Promise.reject(new Error('Redis unreachable')),
    };

    const { result } = renderHook(() => useRecommendationView(monday, api));

    await waitFor(() => {
      expect(result.current.status).toMatchObject({ kind: 'error', message: 'Redis unreachable' });
    });
  });
});
