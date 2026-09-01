import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useTrainerOverview } from '../use-trainer-overview';

import type { MondayBoardContext } from '@components/recommendations/monday-client';
import type { TrainerOverviewPayload } from '@lib/evaluations';
import type { TrainerOverviewApi } from '../api';

afterEach(cleanup);

const EMPTY: TrainerOverviewPayload = { writtenAt: null, stale: false, trainers: [] };

const api: TrainerOverviewApi = { get: () => Promise.resolve(EMPTY) };

/**
 * A bridge whose initial `context()` can be resolved by the test, after a context CHANGE
 * has already been delivered. That ordering is the whole point: `context()` is a promise
 * and `listen('context')` a callback, so nothing guarantees the first read wins the race.
 */
function fakeBridge() {
  const boardsAsked: string[] = [];
  let resolveContext: ((context: MondayBoardContext) => void) | null = null;
  let listener: ((context: MondayBoardContext) => void) | null = null;

  return {
    boardsAsked,
    settleInitial(context: MondayBoardContext) {
      resolveContext?.(context);
    },
    change(context: MondayBoardContext) {
      listener?.(context);
    },
    context(): Promise<MondayBoardContext> {
      return new Promise((resolve) => {
        resolveContext = resolve;
      });
    },
    onContextChange(next: (context: MondayBoardContext) => void) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    sessionToken: () => Promise.resolve('token'),
    api(_document: string, variables?: Record<string, unknown>): Promise<unknown> {
      const board = Array.isArray(variables?.boardId) ? String(variables.boardId[0]) : '';
      if (board !== '') {
        boardsAsked.push(board);
        return Promise.resolve({
          boards: [{ items_page: { cursor: null, items: [{ id: board, name: `Op ${board}` }] } }],
        });
      }
      return Promise.resolve({ items: [] });
    },
  };
}

const context = (boardId: string): MondayBoardContext => ({ boardId, theme: 'light' });

describe('useTrainerOverview and the context race', () => {
  it('lets a context change outrank a slower initial read', async () => {
    const monday = fakeBridge();

    const { result } = renderHook(() => useTrainerOverview(monday, api));

    // Monday moves the view before the first read comes back…
    monday.change(context('board-B'));
    await waitFor(() => {
      expect(monday.boardsAsked).toEqual(['board-B']);
    });

    // …and the stale initial read then resolves with the board we have left.
    monday.settleInitial(context('board-A'));

    await waitFor(() => {
      expect(result.current.names.get('board-B')).toBe('Op board-B');
    });
    expect(monday.boardsAsked).toEqual(['board-B']);
    expect(result.current.rosterIds).toEqual(['board-B']);
  });

  it('uses the initial read when nothing has changed under it', async () => {
    const monday = fakeBridge();

    const { result } = renderHook(() => useTrainerOverview(monday, api));
    monday.settleInitial(context('board-A'));

    await waitFor(() => {
      expect(result.current.rosterIds).toEqual(['board-A']);
    });
    expect(result.current.theme).toBe('light');
  });

  it('carries the theme from a context change', async () => {
    const monday = fakeBridge();

    const { result } = renderHook(() => useTrainerOverview(monday, api));
    monday.change({ boardId: 'board-B', theme: 'dark' });

    await waitFor(() => {
      expect(result.current.theme).toBe('dark');
    });
  });

  /** A context that never arrives has to be distinguishable from one still on its way. */
  it('reports an unreadable context rather than waiting on it forever', async () => {
    const failing = {
      context: () => Promise.reject(new Error('geen context')),
      onContextChange: () => () => {},
      sessionToken: () => Promise.resolve('token'),
      api: () => Promise.resolve({ items: [] }),
    };

    const { result } = renderHook(() => useTrainerOverview(failing, api));

    await waitFor(() => {
      expect(result.current.themeUnavailable).toBe(true);
    });
    expect(result.current.theme).toBeNull();
  });
});

/**
 * Roster readiness has to be keyed to the board being ASKED about, not to a flag.
 *
 * Effects run after the render that changed `boardId`, so for one committed render a
 * boolean set inside the effect still says "not loading" while the data belongs to the
 * previous board. That render is exactly where the wrong groups appear — so this drives a
 * real context change rather than injecting a status.
 */
describe('roster readiness across a board change', () => {
  function bridgeWithHeldBoard(held: string) {
    let listener: ((context: MondayBoardContext) => void) | null = null;
    let releaseHeld: (() => void) | null = null;

    return {
      release() {
        releaseHeld?.();
      },
      change(context: MondayBoardContext) {
        listener?.(context);
      },
      context: () => Promise.resolve(context('board-A')),
      onContextChange(next: (ctx: MondayBoardContext) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      sessionToken: () => Promise.resolve('token'),
      api(_document: string, variables?: Record<string, unknown>): Promise<unknown> {
        const board = Array.isArray(variables?.boardId) ? String(variables.boardId[0]) : '';
        const page = (id: string) => ({
          boards: [{ items_page: { cursor: null, items: [{ id, name: `Op ${id}`, group: { id: 'topics' } }] } }],
        });
        if (board === held) {
          return new Promise((resolve) => {
            releaseHeld = () => {
              resolve(page(board));
            };
          });
        }
        return Promise.resolve(board === '' ? { items: [] } : page(board));
      },
    };
  }

  it('goes back to loading the moment the board changes, before the new roster lands', async () => {
    const monday = bridgeWithHeldBoard('board-B');

    const { result } = renderHook(() => useTrainerOverview(monday, api));

    await waitFor(() => {
      expect(result.current.rosterStatus).toBe('ready');
    });
    expect(result.current.groupById.get('board-A')).toBe('topics');

    monday.change(context('board-B'));

    await waitFor(() => {
      expect(result.current.rosterStatus).toBe('loading');
    });
    // And the previous board's groups are gone rather than lingering as a stale scope.
    expect(result.current.groupById.size).toBe(0);

    monday.release();

    await waitFor(() => {
      expect(result.current.rosterStatus).toBe('ready');
    });
    expect(result.current.groupById.get('board-B')).toBe('topics');
  });

  it('settles on unavailable when the board read fails, rather than waiting forever', async () => {
    const monday = {
      context: () => Promise.resolve(context('board-A')),
      onContextChange: () => () => {},
      sessionToken: () => Promise.resolve('token'),
      api: (_d: string, variables?: Record<string, unknown>) =>
        Array.isArray(variables?.boardId)
          ? Promise.reject(new Error('Monday viel om'))
          : Promise.resolve({ items: [] }),
    };

    const { result } = renderHook(() => useTrainerOverview(monday, api));

    await waitFor(() => {
      expect(result.current.rosterStatus).toBe('unavailable');
    });
  });
});

/**
 * A context change can hand us a perfectly good board while the initial `context()` read
 * is still in flight. If that superseded read then REJECTS, recording it would declare a
 * context we already have to be unavailable — switching the group scope off for good and
 * quietly showing every group.
 */
describe('a superseded context read that fails late', () => {
  it('is ignored once a context change has already arrived', async () => {
    // Holders rather than bare `let`: TypeScript cannot see that a callback assigned
    // these, and narrows them to `never` at the call site.
    const initial: { reject: ((error: Error) => void) | null } = { reject: null };
    const changed: { notify: ((ctx: MondayBoardContext) => void) | null } = { notify: null };

    const monday = {
      context: (): Promise<MondayBoardContext> =>
        new Promise((_resolve, reject) => {
          initial.reject = reject;
        }),
      onContextChange(next: (ctx: MondayBoardContext) => void) {
        changed.notify = next;
        return () => {
          changed.notify = null;
        };
      },
      sessionToken: () => Promise.resolve('token'),
      api: (_d: string, variables?: Record<string, unknown>) =>
        Promise.resolve(
          Array.isArray(variables?.boardId)
            ? {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: 'x', name: 'Anna', group: { id: 'topics' } }],
                    },
                  },
                ],
              }
            : { items: [] }
        ),
    };

    const { result } = renderHook(() => useTrainerOverview(monday, api));

    changed.notify?.({ boardId: 'board-B', theme: 'dark' });
    await waitFor(() => {
      expect(result.current.rosterStatus).toBe('ready');
    });

    initial.reject?.(new Error('te laat'));

    await waitFor(() => {
      expect(result.current.theme).toBe('dark');
    });
    expect(result.current.themeUnavailable).toBe(false);
    expect(result.current.rosterStatus).toBe('ready');
  });
});
