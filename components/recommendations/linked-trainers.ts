'use client';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import type { MondayBridge } from './monday-client';

/**
 * Which trainers are already linked to this training.
 *
 * The recommendation list knows nothing about this: it is computed from the roster and
 * stored in Redis, while the relation lives on the Monday item and can be set by anyone
 * — by a planner in this view, by a colleague in the board, or by n8n's existing
 * "Bevestig Trainer" flow. Reloading our own API after a pick therefore cannot show the
 * result of that pick; only Monday can.
 *
 * Without it the view offers "Kies" on every row forever, with nothing to say that one
 * of them is already the answer — so a second click silently replaces a colleague's
 * choice.
 */

const LINKED_QUERY = `
query ($ids: [ID!], $columnIds: [String!]) {
  items(ids: $ids) {
    id
    column_values(ids: $columnIds) {
      id
      ... on BoardRelationValue { linked_item_ids }
    }
  }
}`;

/**
 * Walk the reply rather than trust it.
 *
 * A board relation is the one Monday shape with a documented history of returning
 * `value: null` while the fragment still carries the ids (see `board-config.ts`), so
 * anything but the fragment path is treated as "no link".
 */
function readLinkedIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    return [];
  }
  const { items } = data;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const [item] = items;
  if (typeof item !== 'object' || item === null || !('column_values' in item)) {
    return [];
  }
  const columns = item.column_values;
  if (!Array.isArray(columns)) {
    return [];
  }

  const linked: string[] = [];
  for (const column of columns) {
    if (typeof column !== 'object' || column === null || !('linked_item_ids' in column)) {
      continue;
    }
    const ids = column.linked_item_ids;
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const id of ids) {
      if (typeof id === 'string' || typeof id === 'number') {
        linked.push(String(id));
      }
    }
  }
  return linked;
}

export async function readLinkedTrainers(
  monday: MondayBridge,
  mondayItemId: string
): Promise<string[]> {
  const data = await monday.api(LINKED_QUERY, {
    ids: [mondayItemId],
    columnIds: [AGENDA_2026_COLUMNS.trainerRelation],
  });
  return readLinkedIds(data);
}
