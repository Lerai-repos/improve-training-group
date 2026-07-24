import type { Qualification } from '@lib/calc';

import type { MondayQualification, MondayThema, MondayTrainer, MondayTraining } from './types';

/**
 * Raw Monday GraphQL shapes and the transport→domain decoder.
 *
 * The critical gotcha (API v2025-04 onward, still present in the pinned 2026-07 —
 * validated against a live 754-row pull): a `board_relation` column's `value` is
 * `null`; linked ids come ONLY from `... on BoardRelationValue { linked_item_ids }`.
 * `mirror` columns return null `text`/`value`; the value comes ONLY from
 * `... on MirrorValue { display_value }`.
 *
 * Decoders return `{ value, diagnostics }` so a MALFORMED value (a non-numeric
 * omzet/duur) is classified, never silently coerced to null — the validator can
 * then tell "empty" apart from "broken".
 */

export interface RawColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
  __typename?: string;
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

export type DiagnosticKind = 'malformed_number' | 'empty_required';

export interface Diagnostic {
  itemId: string;
  field: string;
  kind: DiagnosticKind;
  raw: string | null;
}

export interface Decoded<T> {
  value: T;
  diagnostics: Diagnostic[];
}

/** Maps semantic training fields → Monday column ids (per-year plumbing config). */
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

export interface TrainerColumnMap {
  adres: string;
  email: string;
  itgEmail?: string;
  telefoon: string;
}

/** Themas-board colour board_relation columns → qualification colour. */
export interface QualificationColourMap {
  groen: string;
  oranje: string;
  rood: string;
  grijs: string;
}

const CENTS_PER_EURO = 100;

function columnById(item: RawMondayItem, id: string): RawColumnValue | undefined {
  return item.column_values.find((c) => c.id === id);
}

/** Linked item ids from a board_relation column — NOT the (null) `value`. */
export function linkedItemIds(item: RawMondayItem, id: string): string[] {
  return columnById(item, id)?.linked_item_ids ?? [];
}

/** Mirror display value — NOT the (null) `text`/`value`. Empty string → null. */
export function mirrorValue(item: RawMondayItem, id: string): string | null {
  const v = columnById(item, id)?.display_value;
  return v !== null && v !== undefined && v !== '' ? v : null;
}

function textValue(item: RawMondayItem, id: string): string | null {
  const t = columnById(item, id)?.text;
  return t !== null && t !== undefined && t !== '' ? t : null;
}

/** A number column, classifying non-numeric text as malformed (diagnostic), not null. */
function numberField(
  item: RawMondayItem,
  id: string,
  field: string,
  diags: Diagnostic[]
): number | null {
  const t = textValue(item, id);
  if (t === null) {
    return null;
  }
  const n = Number(t);
  if (Number.isNaN(n)) {
    diags.push({ itemId: item.id, field, kind: 'malformed_number', raw: t });
    return null;
  }
  return n;
}

/** Decode a raw Monday item into a normalized {@link MondayTraining}. */
export function decodeTraining(
  item: RawMondayItem,
  map: TrainingColumnMap
): Decoded<MondayTraining> {
  const diagnostics: Diagnostic[] = [];
  const omzetEuros = numberField(item, map.omzet, 'omzet', diagnostics);
  const value: MondayTraining = {
    externalItemId: item.id,
    externalBoardId: item.board?.id ?? '',
    externalGroupId: item.group?.id ?? null,
    datum: textValue(item, map.datum),
    tijd: map.tijd ? textValue(item, map.tijd) : null,
    taal: map.taal ? textValue(item, map.taal) : null,
    duurTraining: numberField(item, map.duur, 'duur', diagnostics),
    // Training status (Nieuw/…) is derived, not a column — left null in M2a.
    status: null,
    ieCode: textValue(item, map.ieCode),
    omzetCents: omzetEuros === null ? null : Math.round(omzetEuros * CENTS_PER_EURO),
    locatie: textValue(item, map.locatie),
    label: textValue(item, map.label),
    companyName: mirrorValue(item, map.companyMirror),
    trainerExternalIds: linkedItemIds(item, map.trainerRelation),
    themaExternalIds: linkedItemIds(item, map.themaRelation),
    // Stable klant key is derived from companyName in the sync (no Opportunities traversal).
    klantExternalIds: [],
  };
  return { value, diagnostics };
}

/** Decode a raw trainer item. `naam` is the item name; rateKey is resolved downstream. */
export function decodeTrainer(item: RawMondayItem, map: TrainerColumnMap): Decoded<MondayTrainer> {
  const diagnostics: Diagnostic[] = [];
  const naam = item.name?.trim() ?? '';
  if (naam === '') {
    diagnostics.push({ itemId: item.id, field: 'naam', kind: 'empty_required', raw: item.name });
  }
  const value: MondayTrainer = {
    externalItemId: item.id,
    externalBoardId: item.board?.id ?? '',
    naam,
    adres: textValue(item, map.adres),
    email: textValue(item, map.email) ?? (map.itgEmail ? textValue(item, map.itgEmail) : null),
    telefoon: textValue(item, map.telefoon),
    mondayGroup: item.group?.id ?? null,
    rateKey: null,
  };
  return { value, diagnostics };
}

/** Decode a raw thema item. `thema` is the item name. */
export function decodeThema(item: RawMondayItem): Decoded<MondayThema> {
  const diagnostics: Diagnostic[] = [];
  const thema = item.name?.trim() ?? '';
  if (thema === '') {
    diagnostics.push({ itemId: item.id, field: 'thema', kind: 'empty_required', raw: item.name });
  }
  return {
    value: { externalItemId: item.id, externalBoardId: item.board?.id ?? '', thema },
    diagnostics,
  };
}

/**
 * Decode qualifications from ONE Themas-board item: each colour board_relation
 * column lists the trainers with that qualification for this theme. Emits one
 * observation per (trainer, colour), tagging the source column for provenance.
 */
export function decodeQualificationsFromThema(
  item: RawMondayItem,
  colours: QualificationColourMap
): MondayQualification[] {
  const themaExternalId = item.id;
  const byColour: Array<[Qualification, string]> = [
    ['groen', colours.groen],
    ['oranje', colours.oranje],
    ['rood', colours.rood],
    ['grijs', colours.grijs],
  ];
  return byColour.flatMap(([qualification, columnId]) =>
    linkedItemIds(item, columnId).map((trainerExternalId) => ({
      trainerExternalId,
      themaExternalId,
      qualification,
      sourceColumn: columnId,
    }))
  );
}
