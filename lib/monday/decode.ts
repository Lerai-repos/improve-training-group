import type { MondayTraining } from './types';

/**
 * Raw Monday GraphQL shapes and the transport→domain decoder.
 *
 * The critical gotcha (API v2025-04+): a `board_relation` column's `value` is
 * `null`; linked ids come ONLY from the `... on BoardRelationValue { linked_item_ids }`
 * fragment. `mirror` columns return null `text`/`value`; the value comes ONLY
 * from `... on MirrorValue { display_value }`. This decoder reads the fragment
 * fields, never `value`/`text`, so linked ids and mirrors don't silently vanish.
 */

export interface RawColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
  /** From `... on BoardRelationValue { linked_item_ids }`. */
  linked_item_ids?: string[] | null;
  /** From `... on MirrorValue { display_value }`. */
  display_value?: string | null;
}

export interface RawMondayItem {
  id: string;
  name: string;
  board: { id: string } | null;
  group: { id: string } | null;
  column_values: RawColumnValue[];
}

/**
 * Maps semantic training fields → Monday column ids (per-year plumbing config).
 *
 * Notes on the real Agenda board (see monday.md): `label` is the `status23`
 * status column (a label code like IT/JE), `locatie` is `tekst7`, `omzet` is the
 * `O` revenue column (`nummers`, EUR), and the client is a mirror (`companyMirror`
 * = `lookup_mkszzfvr`, via Opportunities) giving the company NAME. Training
 * `status` (Nieuw/…) is DERIVED, not a column, so this decoder leaves it null.
 */
export interface TrainingColumnMap {
  trainerRelation: string;
  themaRelation: string;
  companyMirror: string;
  datum: string;
  duur: string;
  ieCode: string;
  locatie: string;
  label: string;
  omzet: string;
  tijd?: string;
  taal?: string;
}

const CENTS_PER_EURO = 100;

function columnById(item: RawMondayItem, id: string): RawColumnValue | undefined {
  return item.column_values.find((c) => c.id === id);
}

/** Linked item ids from a board_relation column — NOT the (null) `value`. */
export function linkedItemIds(item: RawMondayItem, id: string): string[] {
  return columnById(item, id)?.linked_item_ids ?? [];
}

/** Mirror display value — NOT the (null) `text`/`value`. */
export function mirrorValue(item: RawMondayItem, id: string): string | null {
  return columnById(item, id)?.display_value ?? null;
}

function textValue(item: RawMondayItem, id: string): string | null {
  const t = columnById(item, id)?.text;
  return t !== null && t !== undefined && t !== '' ? t : null;
}

function numberValue(item: RawMondayItem, id: string): number | null {
  const t = textValue(item, id);
  if (t === null) {
    return null;
  }
  // Non-numeric text (a stray label, or Dutch-formatted "1.234,50") → null,
  // never NaN — NaN would corrupt an omzet_cents / duur_training insert.
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** Decode a raw Monday item into a normalized {@link MondayTraining}. */
export function decodeTraining(item: RawMondayItem, map: TrainingColumnMap): MondayTraining {
  const omzetEuros = numberValue(item, map.omzet);
  return {
    externalItemId: item.id,
    externalBoardId: item.board?.id ?? '',
    externalGroupId: item.group?.id ?? null,
    datum: textValue(item, map.datum),
    tijd: map.tijd ? textValue(item, map.tijd) : null,
    taal: map.taal ? textValue(item, map.taal) : null,
    duurTraining: numberValue(item, map.duur),
    // Training status (Nieuw/…) is derived, not a column — set in the connection phase.
    status: null,
    ieCode: textValue(item, map.ieCode),
    omzetCents: omzetEuros === null ? null : Math.round(omzetEuros * CENTS_PER_EURO),
    locatie: textValue(item, map.locatie),
    label: textValue(item, map.label),
    companyName: mirrorValue(item, map.companyMirror),
    trainerExternalIds: linkedItemIds(item, map.trainerRelation),
    themaExternalIds: linkedItemIds(item, map.themaRelation),
    // Stable client id needs the Opportunities traversal (connection phase).
    klantExternalIds: [],
  };
}
