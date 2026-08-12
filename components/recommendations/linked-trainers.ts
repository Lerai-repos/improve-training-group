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
 * Walk the reply rather than trust it — and THROW rather than answer "nobody" when the
 * shape is not what we asked for.
 *
 * This is the reader an append builds its union from, so a fail-open `[]` is data loss:
 * a partial response, a renamed column or any shape drift would read as "no trainers are
 * linked", and the write that follows would replace every real link with the one being
 * picked. The same rule serves the display path, where a throw becomes
 * `linked: {kind: 'error'}` and disables picking — also the safe direction.
 *
 * An EMPTY relation is not an error and must not be confused with a missing one: the
 * column is present with no ids, and Monday has a documented habit of sending `value:
 * null` on relations while the fragment carries the ids (see `board-config.ts`), so an
 * absent or null `linked_item_ids` on a column that IS present reads as empty.
 */
function readLinkedIds(data: unknown, columnId: string): string[] {
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    throw new Error('Monday relation read: no items in the reply');
  }
  const { items } = data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Monday relation read: the training was not returned');
  }
  const [item] = items;
  if (typeof item !== 'object' || item === null || !('column_values' in item)) {
    throw new Error('Monday relation read: the item carries no column_values');
  }
  const columns = item.column_values;
  if (!Array.isArray(columns)) {
    throw new Error('Monday relation read: column_values is not a list');
  }

  const column = columns.find(
    (c) => typeof c === 'object' && c !== null && 'id' in c && c.id === columnId
  );
  if (column === undefined) {
    // The trainer relation itself is missing from the reply. Answering "nobody is linked"
    // here is precisely how an append turns into a replace.
    throw new Error(`Monday relation read: column ${columnId} is missing from the reply`);
  }

  /**
   * The key must be PRESENT. Its absence is the one signal of column-type drift.
   *
   * `... on BoardRelationValue` simply does not match if the column stops being a board
   * relation, and GraphQL then omits the field rather than erroring — so a text column read
   * through this query returns `{id}` and nothing else. Treating that as an empty relation
   * is how an append would wipe every existing link on a perfectly successful 200.
   *
   * Measured against the live board: an EMPTY relation sends `linked_item_ids: []` and a
   * filled one sends the ids, both with the key present; a text column omits it entirely.
   * So requiring presence separates "nobody is linked" from "this is not a relation".
   */
  if (!('linked_item_ids' in column)) {
    throw new Error(
      `Monday relation read: ${columnId} returned no linked_item_ids — is it still a board relation?`
    );
  }
  const raw = column.linked_item_ids;
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`Monday relation read: ${columnId} did not return a list of ids`);
  }

  const linked: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error(`Monday relation read: ${columnId} returned a non-id entry`);
    }
    linked.push(String(id));
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
  return readLinkedIds(data, AGENDA_2026_COLUMNS.trainerRelation);
}
