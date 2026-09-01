'use client';

import { useEffect, useState } from 'react';

import type { MondayBoardBridge } from '@components/recommendations/monday-client';

/**
 * Every trainer on the board this tab is a view of.
 *
 * The statistics record is NOT a roster. `computeTrainerThemaStats` only emits a row for
 * a (trainer × thema) pair that either has completed history or an assessed groen/oranje
 * qualification — so a trainer who is only rood or grijs, and has never taught a themed
 * training, appears nowhere in it. Building the table from the statistics alone means
 * "alleen trainers met evaluaties" cannot actually be switched off: the people it would
 * reveal were never in the payload.
 *
 * So the roster is read here rather than on the server, and from the board the view is
 * already sitting on. Three reasons that is the right side:
 *
 * 1. the tab IS the trainers board, so `context.boardId` is the roster, for free;
 * 2. the endpoint stays one Redis read — no Monday call, no second failure mode, no
 *    latency on a screen that opens with 171 rows;
 * 3. it reads as the logged-in planner, so their own board permissions apply, exactly as
 *    the name lookup already does.
 *
 * It also replaces the batched `items(ids:)` name lookup for trainers: one page of the
 * board hands back id AND name together, so nothing is asked for twice.
 */

const ROSTER_QUERY = `
query ($boardId: [ID!], $cursor: String) {
  boards(ids: $boardId) {
    items_page(limit: 500, cursor: $cursor) {
      cursor
      items { id name group { id } }
    }
  }
}`;

/**
 * A hard stop on the cursor loop.
 *
 * 500 per page against a roster of ~171 means one page in practice. The bound exists so
 * that a Monday change which returns a cursor forever cannot turn an open tab into an
 * endless request loop against the client's own account.
 */
const MAX_PAGES = 20;

interface RosterItem {
  readonly id: string;
  readonly name: string;
  /** Which board group the trainer sits in; '' when Monday did not say. */
  readonly groupId: string;
}

interface Page {
  readonly cursor: string | null;
  readonly items: readonly RosterItem[];
}

/**
 * Walk the reply rather than cast it. This is the one shape Monday owns, and a partially
 * failed query still returns a well-formed envelope with pieces missing.
 */
function readPage(data: unknown): Page {
  const empty: Page = { cursor: null, items: [] };
  if (typeof data !== 'object' || data === null || !('boards' in data)) {
    return empty;
  }
  const { boards } = data;
  if (!Array.isArray(boards) || boards.length === 0) {
    return empty;
  }
  const [board] = boards;
  if (typeof board !== 'object' || board === null || !('items_page' in board)) {
    return empty;
  }
  const page = board.items_page;
  if (typeof page !== 'object' || page === null || !('items' in page)) {
    return empty;
  }
  const cursor =
    'cursor' in page && typeof page.cursor === 'string' && page.cursor !== '' ? page.cursor : null;
  if (!Array.isArray(page.items)) {
    return { cursor, items: [] };
  }

  const items: RosterItem[] = [];
  for (const item of page.items) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('name' in item)) {
      continue;
    }
    const { id, name } = item;
    if (!(typeof id === 'string' || typeof id === 'number') || typeof name !== 'string') {
      continue;
    }
    const group =
      'group' in item && typeof item.group === 'object' && item.group !== null && 'id' in item.group
        ? item.group.id
        : null;
    items.push({
      id: String(id),
      name,
      groupId: typeof group === 'string' || typeof group === 'number' ? String(group) : '',
    });
  }
  return { cursor, items };
}

export interface Roster {
  /** Every trainer item on the board, in board order. */
  readonly ids: readonly string[];
  readonly names: ReadonlyMap<string, string>;
  /** Trainer id → board group id, so the view can scope which groups it lists. */
  readonly groupById: ReadonlyMap<string, string>;
  /**
   * WHICH board the state above describes, or null before anything has settled.
   *
   * Exposed rather than a bare `loading` flag because effects run AFTER the render that
   * changed `boardId`: for that one committed render a boolean still reads false while
   * the data belongs to the previous board. Callers compare this against the board they
   * asked for, which is a question that can be answered synchronously.
   */
  readonly loadedFor: string | null;
  readonly loading: boolean;
  /**
   * Set when the roster could not be read.
   *
   * The table still renders from the statistics alone in that case — fewer trainers, but
   * every number correct — which is why this degrades rather than throws.
   */
  readonly error: string | null;
}

export function useRoster(monday: Pick<MondayBoardBridge, 'api'>, boardId: string | null): Roster {
  const [ids, setIds] = useState<readonly string[]>([]);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [groupById, setGroupById] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (boardId === null) {
      return;
    }

    let cancelled = false;
    /**
     * Clear before fetching, not after.
     *
     * `boardId` changing means we are looking at a DIFFERENT board — Monday can swap the
     * context under a mounted view. Keeping the previous ids while the next request is in
     * flight leaves the other board's trainers in the table, and a slow or failed request
     * leaves them there for good. An empty moment is honest; the wrong roster is not.
     */
    setIds([]);
    setNames(new Map());
    setGroupById(new Map());
    setError(null);
    /**
     * And the state no longer describes ANY board.
     *
     * Clearing the maps without clearing this leaves a lie behind on an A → B → A trip:
     * B's effect erases A's roster while `loadedFor` still says A, so coming back to A
     * before B has settled reads as "already loaded" over empty maps — and the table
     * renders unscoped until the new request lands.
     */
    setLoadedFor(null);

    const collect = async (): Promise<Page['items']> => {
      const all: RosterItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data: unknown = await monday.api(ROSTER_QUERY, { boardId: [boardId], cursor });
        const read = readPage(data);
        all.push(...read.items);
        if (read.cursor === null) {
          return all;
        }
        cursor = read.cursor;
      }
      return all;
    };

    collect()
      .then((items) => {
        if (cancelled) {
          return;
        }
        setIds(items.map((item) => item.id));
        setNames(new Map(items.map((item) => [item.id, item.name])));
        setGroupById(new Map(items.map((item) => [item.id, item.groupId])));
        setError(null);
        setLoadedFor(boardId);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          // Nothing partial survives a failure either: a half-read roster shown as if it
          // were whole is the same wrong answer, just harder to notice.
          setIds([]);
          setNames(new Map());
          setGroupById(new Map());
          setError(cause instanceof Error ? cause.message : String(cause));
          // Settled, badly, but settled FOR THIS BOARD — otherwise a failure reads as
          // "still loading" and the table waits on a request that will never arrive.
          setLoadedFor(boardId);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [boardId, monday]);

  // Derived, not stored: a boolean set inside the effect is one render late, which is
  // exactly the window in which the previous board's roster is still on screen.
  const loading = boardId !== null && loadedFor !== boardId;

  return { ids, names, groupById, loadedFor, loading, error };
}
