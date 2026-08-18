import {
  resolveGroupPolicy,
  TRAINER_COLUMNS,
  TRAINER_ENGINE_COLUMNS,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import { decodeTrainer, type RawMondayItem } from '@lib/monday/decode';
import { assertColumns } from '@lib/monday/schema-check';
import { parseUurtarief } from '@lib/trainers/uurtarief';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { ExpectedColumn } from '@lib/monday/board-config';

import type { CandidateTrainer } from './types';
import type { MondayTrainer } from '@lib/monday';

/**
 * The trainer roster, read LIVE from the Monday trainers board. Replaces the
 * Postgres mirror: there is no snapshot, so there is nothing to go stale.
 *
 * This module is the authoritative roster boundary, which makes it the right place
 * for the two rules that were previously scattered:
 *
 *  1. `rateKey`. The decoder deliberately leaves it null ("resolved downstream")
 *     and the ONLY place it was ever filled was `scripts/sync-monday.ts`. Miss it
 *     and every trainer is unpriceable, every run returns GEEN MATCH, and nothing
 *     errors — `no_rate` is a designed exclusion, not a fault.
 *  2. The `*NOTK` placeholder. It is not a person, but it IS linked from real
 *     training records, so without an explicit exclusion it can be ranked and
 *     recommended to a planner.
 *
 * It deliberately does NOT filter by configured group — `groups:list` and the
 * readiness API must be able to report on groups nobody has selected yet. The
 * `recommendableGroups` filter belongs to the recommendation service.
 */

/** The `*NOTK` placeholder trainer (`docs/build/08-valkuilen.md`). Not a person. */
export const NOTK_PLACEHOLDER_ITEM_ID = '2638479433';

/** Board reader — the same paginating, completeness-checked fetch the sync used. */
interface BoardReader {
  fetchBoardItems<T extends { id: string }>(
    boardId: string,
    fields: string,
    itemsCount: number | null
  ): Promise<T[]>;
  getSchema(boardIds: string[]): Promise<BoardMeta[]>;
}

/**
 * Validate the board schema and return its metadata (including `items_count`).
 *
 * The schema check is not optional. The sync-time validator that used to police
 * this is deleted along with the database, and the decoders FAIL OPEN: a missing or
 * retyped `adres` column becomes `null` for every trainer, so they are all excluded
 * as `no_address` and the run returns a plausible GEEN MATCH with no error. Monday
 * ships breaking column changes without warning (`08-valkuilen.md`), so drift has to
 * fail closed here, at the read boundary.
 *
 * Callers may pass ALREADY-FETCHED metadata to avoid a second `getSchema` round
 * trip — but it is still validated here. Taking a bare item count instead would let
 * a caller skip validation entirely just by supplying the number, which is exactly
 * the hole a well-meaning optimization opens.
 */
export async function assertBoard(
  client: BoardReader,
  boardId: string,
  expected: readonly ExpectedColumn[],
  prefetched?: BoardMeta
): Promise<BoardMeta> {
  const board =
    prefetched ?? (await client.getSchema([boardId])).find((b) => String(b.id) === boardId);
  if (!board) {
    throw new Error(`board ${boardId} not returned by Monday`);
  }
  if (String(board.id) !== boardId) {
    throw new Error(`board metadata mismatch: got ${board.id}, expected ${boardId}`);
  }
  assertColumns(board, expected);
  return board;
}

/**
 * Per-ITEM presence check for the columns the engine consumes.
 *
 * The board-level preflight cannot catch a payload that is incomplete for a single
 * item, or a column change that RACES the preflight. And `decodeTrainer` fails open:
 * `textValue` maps an absent column to `null` exactly as it maps an empty one, so a
 * missing `adres__1` silently excludes that trainer as `no_address` — which reads as
 * a legitimate answer. An empty value is fine; an ABSENT column is not.
 */
function assertTrainerColumns(item: RawMondayItem): void {
  const present = new Set((item.column_values ?? []).map((c) => c.id));
  for (const [field, columnId] of Object.entries(TRAINER_COLUMNS)) {
    if (columnId !== undefined && !present.has(columnId)) {
      throw new Error(`trainer ${item.id}: missing ${field} column ${columnId}`);
    }
  }
}

/** Decoded Monday trainers → engine candidates. Pure; the I/O lives in `readRoster`. */
export function toRoster(trainers: readonly MondayTrainer[]): CandidateTrainer[] {
  return trainers
    .filter((t) => t.externalItemId !== NOTK_PLACEHOLDER_ITEM_ID)
    .map((t) => ({
      externalItemId: t.externalItemId,
      naam: t.naam,
      adres: t.adres,
      mondayGroup: t.mondayGroup,
      rateKey: resolveGroupPolicy(t.mondayGroup)?.rateKey ?? null,
      rateOverride: parseUurtarief(t.uurtariefRaw),
    }));
}

/** The full live roster, every group included. */
export async function readRoster(
  client: BoardReader,
  itemFields: string,
  prefetched?: BoardMeta
): Promise<CandidateTrainer[]> {
  const board = await assertBoard(client, TRAINERS_BOARD, TRAINER_ENGINE_COLUMNS, prefetched);
  const raw = await client.fetchBoardItems<RawMondayItem>(
    TRAINERS_BOARD,
    itemFields,
    board.items_count
  );
  // Per-item decode diagnostics are dropped on purpose: one trainer with a blank
  // optional field must not fail a run. Board-level SCHEMA drift is different and is
  // already fatal above — that is the failure that would silently empty the roster.
  const decoded = raw.map((item) => {
    assertTrainerColumns(item);
    return decodeTrainer(item, TRAINER_COLUMNS).value;
  });
  return toRoster(decoded);
}
