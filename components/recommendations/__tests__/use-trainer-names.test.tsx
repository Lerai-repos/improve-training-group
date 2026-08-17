import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTrainerNames } from '../use-trainer-names';

import type { MondayBridge } from '../monday-client';

afterEach(cleanup);

/**
 * A Monday that enforces the real cap.
 *
 * `items(ids:)` returns at most 25 rows when the query gives no `limit`, and reports
 * nothing about the ones it dropped. A fake that always answers in full would let this
 * hook regress to exactly the bug these tests exist for: names silently replaced by
 * `#3138198919` for whoever fell off the end.
 */
function fakeMonday(): MondayBridge & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    api(document: string, variables?: Record<string, unknown>): Promise<unknown> {
      calls.push(variables ?? {});
      const ids = (variables?.ids as string[]) ?? [];
      const limit = typeof variables?.limit === 'number' ? variables.limit : 25;
      const served = ids.slice(0, Math.min(limit, 100));
      return Promise.resolve({
        items: served.map((id) => ({ id, name: `Trainer ${id}` })),
      });
    },
  } as unknown as MondayBridge & { calls: Array<Record<string, unknown>> };
}

const idsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => String(1000 + i));

describe('useTrainerNames', () => {
  /**
   * The regression. 28 ranked trainers is an ordinary training, and without an explicit
   * limit three of them come back nameless — scattered through the table rather than at
   * the end, because Monday's return order is not our ranking order.
   */
  it('names all 28 trainers of an ordinary training', async () => {
    const monday = fakeMonday();
    const ids = idsOf(28);

    const { result } = renderHook(() => useTrainerNames(monday, ids));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.byId.size).toBe(28);
    expect(result.current.error).toBeNull();
  });

  it('asks for a limit at all', async () => {
    const monday = fakeMonday();

    renderHook(() => useTrainerNames(monday, idsOf(28)));

    await waitFor(() => expect(monday.calls.length).toBeGreaterThan(0));
    expect(monday.calls[0].limit).toBe(28);
  });

  /** Monday's own ceiling for one page, so a longer list has to be split. */
  it('splits a list longer than one page', async () => {
    const monday = fakeMonday();
    const ids = idsOf(150);

    const { result } = renderHook(() => useTrainerNames(monday, ids));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(monday.calls.length).toBe(2);
    expect(result.current.byId.size).toBe(150);
  });

  /**
   * Falling back to an id is the graceful part; doing it silently is not. A short answer
   * looks identical to a trainer who simply has no name, so it has to say so.
   */
  it('reports a short answer instead of quietly showing ids', async () => {
    const monday = {
      api: vi.fn(async () => ({ items: [{ id: '1000', name: 'Billie Bos' }] })),
    } as unknown as MondayBridge;

    const { result } = renderHook(() => useTrainerNames(monday, idsOf(3)));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.byId.size).toBe(1);
    expect(result.current.error).toMatch(/1 van de 3/);
  });

  it('says nothing is wrong when every name came back', async () => {
    const monday = fakeMonday();

    const { result } = renderHook(() => useTrainerNames(monday, idsOf(3)));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
