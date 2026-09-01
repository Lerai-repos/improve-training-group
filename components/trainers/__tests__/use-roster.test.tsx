import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRoster } from '../use-roster';

afterEach(cleanup);

/**
 * A Monday that paginates. The roster is ~171 trainers against a page size of 500, so one
 * page is the real case — but a fake that never returns a cursor would let the loop
 * regress to reading only the first page the day the board grows or Monday's ceiling drops.
 */
function fakeMonday(pages: { id: string; name: string }[][], failAfter = Infinity) {
  const calls: (string | null)[] = [];
  return {
    calls,
    api(_document: string, variables?: Record<string, unknown>): Promise<unknown> {
      const cursor = typeof variables?.cursor === 'string' ? variables.cursor : null;
      calls.push(cursor);
      if (calls.length > failAfter) {
        return Promise.reject(new Error('Monday viel om'));
      }
      const index = cursor === null ? 0 : Number(cursor);
      const items = pages[index] ?? [];
      const more = index + 1 < pages.length;
      return Promise.resolve({
        boards: [{ items_page: { cursor: more ? String(index + 1) : null, items } }],
      });
    },
  };
}

describe('useRoster', () => {
  it('reads a single page', async () => {
    const monday = fakeMonday([[{ id: '1', name: 'Anna' }, { id: '2', name: 'Bert' }]]);

    const { result } = renderHook(() => useRoster(monday, 'board-1'));

    await waitFor(() => {
      expect(result.current.ids).toEqual(['1', '2']);
    });
    expect(result.current.names.get('2')).toBe('Bert');
    expect(monday.calls).toEqual([null]);
  });

  it('follows the cursor until it runs out', async () => {
    const monday = fakeMonday([
      [{ id: '1', name: 'Anna' }],
      [{ id: '2', name: 'Bert' }],
      [{ id: '3', name: 'Carla' }],
    ]);

    const { result } = renderHook(() => useRoster(monday, 'board-1'));

    await waitFor(() => {
      expect(result.current.ids).toEqual(['1', '2', '3']);
    });
    expect(monday.calls).toEqual([null, '1', '2']);
  });

  /**
   * Degrades rather than throws: without the roster the table still renders from the
   * statistics, with fewer trainers and every number correct.
   */
  it('reports a failure instead of breaking the table', async () => {
    const monday = fakeMonday([[{ id: '1', name: 'Anna' }]], 0);

    const { result } = renderHook(() => useRoster(monday, 'board-1'));

    await waitFor(() => {
      expect(result.current.error).toBe('Monday viel om');
    });
    expect(result.current.ids).toEqual([]);
  });

  it('asks for nothing until the board id is known', () => {
    const monday = fakeMonday([[{ id: '1', name: 'Anna' }]]);

    renderHook(() => useRoster(monday, null));

    expect(monday.calls).toEqual([]);
  });

  /** A reply missing the pieces we walk for is empty, not a crash. */
  it('survives a reply with no boards in it', async () => {
    const monday = {
      api: () => Promise.resolve({ boards: [] }),
    };

    const { result } = renderHook(() => useRoster(monday, 'board-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.ids).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

/**
 * Monday can swap the board under a mounted view. The previous board's trainers must not
 * survive that — not while the next request is in flight, and not if it never arrives.
 */
describe('when the board changes', () => {
  it('drops the previous roster while the next one loads', async () => {
    let release: (() => void) | null = null;
    const monday = {
      api: (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
        const board = Array.isArray(variables?.boardId) ? String(variables.boardId[0]) : '';
        if (board === 'board-1') {
          return Promise.resolve({
            boards: [{ items_page: { cursor: null, items: [{ id: '1', name: 'Anna' }] } }],
          });
        }
        // The second board never answers, which is the case this test exists for.
        return new Promise((resolve) => {
          release = () => {
            resolve({ boards: [{ items_page: { cursor: null, items: [] } }] });
          };
        });
      },
    };

    const { result, rerender } = renderHook(({ board }) => useRoster(monday, board), {
      initialProps: { board: 'board-1' },
    });

    await waitFor(() => {
      expect(result.current.ids).toEqual(['1']);
    });

    rerender({ board: 'board-2' });

    await waitFor(() => {
      expect(result.current.ids).toEqual([]);
    });
    expect(result.current.names.size).toBe(0);
    expect(release).not.toBeNull();
  });

  it('keeps nothing from a roster that failed to load', async () => {
    let attempt = 0;
    const monday = {
      api: (): Promise<unknown> => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve({
            boards: [{ items_page: { cursor: null, items: [{ id: '1', name: 'Anna' }] } }],
          });
        }
        return Promise.reject(new Error('Monday viel om'));
      },
    };

    const { result, rerender } = renderHook(({ board }) => useRoster(monday, board), {
      initialProps: { board: 'board-1' },
    });

    await waitFor(() => {
      expect(result.current.ids).toEqual(['1']);
    });

    rerender({ board: 'board-2' });

    await waitFor(() => {
      expect(result.current.error).toBe('Monday viel om');
    });
    expect(result.current.ids).toEqual([]);
    expect(result.current.names.size).toBe(0);
  });
});

/**
 * The round trip. Going A → B → A before B settles used to read as "already loaded",
 * because `loadedFor` still said A while B's effect had already erased A's roster — so
 * the table rendered against empty maps and lost its group scope.
 */
describe('returning to a board whose request never finished', () => {
  it('is loading again, not falsely ready on the cleared maps', async () => {
    let releaseB: (() => void) | null = null;
    const page = (id: string) => ({
      boards: [{ items_page: { cursor: null, items: [{ id, name: `Op ${id}` }] } }],
    });
    const monday = {
      api: (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
        const board = Array.isArray(variables?.boardId) ? String(variables.boardId[0]) : '';
        if (board === 'board-B') {
          return new Promise((resolve) => {
            releaseB = () => {
              resolve(page(board));
            };
          });
        }
        return Promise.resolve(page(board));
      },
    };

    const { result, rerender } = renderHook(({ board }) => useRoster(monday, board), {
      initialProps: { board: 'board-A' },
    });

    await waitFor(() => {
      expect(result.current.loadedFor).toBe('board-A');
    });

    rerender({ board: 'board-B' });
    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    // Back to A while B is still hanging.
    rerender({ board: 'board-A' });

    expect(result.current.loadedFor).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loadedFor).toBe('board-A');
    });
    expect(result.current.ids).toEqual(['board-A']);
    expect(releaseB).not.toBeNull();
  });
});
