import {
  ITEM_FIELDS,
  THEMA_EXPECTED_COLUMNS,
  THEMA_QUAL_COLOURS,
  THEMAS_BOARD,
} from '@lib/monday/board-config';
import { decodeQualificationsFromThema, type RawMondayItem } from '@lib/monday/decode';

import { computeEffectiveQuals } from './eligibility';
import { assertBoard } from './roster';

import type { Acknowledgements } from '@lib/monday';
import type { EffectiveQual, QualObservation } from './types';

/**
 * Every trainer×theme effective qualification, read live across the WHOLE Thema's
 * board. The readiness report has to reason about groups nobody has selected, so
 * unlike a recommendation run it cannot scope to one training's themes.
 *
 * It deliberately does NOT reuse `readThemeQualifications`: that fetches by
 * `items(ids:)`, which Monday caps — asking for all 101 themes silently returns a
 * subset, and the reader's fail-closed check then rejects the whole read. This is
 * the same batch limit that broke the fase-1 sync at 101 themes
 * (`docs/build/08-valkuilen.md`). The paginated board read has no such ceiling and
 * additionally proves completeness and coherence.
 */
type BoardReader = Parameters<typeof assertBoard>[0];
type BoardMeta = Awaited<ReturnType<typeof assertBoard>>;

/**
 * Per-ITEM presence check, mirroring `parseThemeQualifications`. The board-level
 * schema preflight cannot catch a payload that is incomplete for one item, or a
 * column change that races the preflight — and `decodeQualificationsFromThema`
 * treats a missing column or a missing `linked_item_ids` field as an EMPTY
 * relation, silently erasing every trainer for that theme.
 */
function assertRelationPayloads(item: RawMondayItem): void {
  for (const [colour, columnId] of Object.entries(THEMA_QUAL_COLOURS)) {
    const col = (item.column_values ?? []).find((c) => c.id === columnId);
    if (!col) {
      throw new Error(`theme ${item.id}: missing ${colour} column ${columnId}`);
    }
    // An explicit empty array is fine; an ABSENT field means the column is no longer
    // a BoardRelationValue, which must not read as "no trainers".
    if (col.linked_item_ids === undefined) {
      throw new Error(
        `theme ${item.id}: ${colour} column ${columnId} returned no linked_item_ids ` +
          `(drifted off BoardRelationValue?)`
      );
    }
  }
}

/**
 * The RAW colour observations across the whole Thema's board.
 *
 * Split out from {@link readAllEffectiveQuals}, which computes exactly this and then
 * throws it away. The effective verdict collapses to green/red for ranking, so it
 * cannot answer two questions the evaluation statistics need: which colour to show on
 * the stats board, and whether a pair earns a row at all. `deriveEffective` returns
 * `null` for an orange-only pair, a grey-only pair and an unobserved pair alike —
 * anything keyed on it silently loses every orange pair.
 */
export async function readQualObservations(
  client: BoardReader,
  prefetched?: BoardMeta
): Promise<QualObservation[]> {
  // Fail closed on board-level drift: a missing/retyped colour relation decodes to
  // an EMPTY array, so every trainer looks unqualified and the report reads as
  // "nobody is green" rather than "the board changed". `items_count` comes from the
  // same validated metadata, so completeness can be proven too.
  const board = await assertBoard(client, THEMAS_BOARD, THEMA_EXPECTED_COLUMNS, prefetched);
  const themas = await client.fetchBoardItems<RawMondayItem>(
    THEMAS_BOARD,
    ITEM_FIELDS,
    board.items_count
  );
  return themas.flatMap((item) => {
    assertRelationPayloads(item);
    return decodeQualificationsFromThema(item, THEMA_QUAL_COLOURS).map((q) => ({
      trainerExternalId: q.trainerExternalId,
      themaExternalId: q.themaExternalId,
      colour: q.qualification,
    }));
  });
}

export async function readAllEffectiveQuals(
  client: BoardReader,
  ack: Acknowledgements,
  prefetched?: BoardMeta
): Promise<EffectiveQual[]> {
  return computeEffectiveQuals(await readQualObservations(client, prefetched), ack);
}
