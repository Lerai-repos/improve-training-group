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
