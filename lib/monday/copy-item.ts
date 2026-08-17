/**
 * Copying an item between boards, without losing half of it.
 *
 * Monday has no cross-board copy — `duplicate_item` is same-board only — so the only
 * route is to read an item's column values and write them into a `create_item`. That
 * looks trivial and is not, because of one asymmetry:
 *
 *   **A board_relation returns `value: null` even when it is populated.**
 *
 * Its contents live in `linked_item_ids`, and writes take a third shape again
 * (`{item_ids: [...]}`). So the obvious loop — "copy every column whose value is not
 * null" — silently drops every relation. The copy looks complete in the UI and in a
 * text diff, and only misbehaves later: an agenda item without its thema link produces
 * a perfectly legitimate GEEN MATCH, which reads as an engine bug rather than a missing
 * field. That cost an hour once; this module exists so it costs nobody an hour again.
 *
 * The same trap is flagged at the top of `board-config.ts` for the READ path.
 */

import { z } from 'zod';

/** One source cell, as the API returns it. */
export interface SourceCell {
  id: string;
  type: string;
  value?: string | null;
  /** The rendered value. Used for COMPARING, because `value` carries server metadata. */
  text?: string | null;
  /** Populated only on `BoardRelationValue`, and the ONLY place a relation's content is. */
  linked_item_ids?: readonly string[] | null;
}

export interface CopyPayload {
  /** Ready for `create_item(column_values:)` — relations already in write shape. */
  values: Record<string, unknown>;
  /** Deliberately left behind — computed by Monday, or explicitly excluded. */
  skipped: Array<{ columnId: string; reason: string }>;
  /**
   * Columns whose value could not be read at all. Kept SEPARATE from `skipped`, which is
   * a list of decisions: this is a list of failures, and a caller should refuse to write
   * a copy it already knows is incomplete rather than discover it in the read-back — by
   * which point there is a half-built item on the board to clean up.
   */
  unreadable: string[];
}

/**
 * Types Monday computes or refuses on write. Sending them either errors or is ignored,
 * and ignoring an error is how a copy silently loses a field.
 */
export function isComputedType(type: string): boolean {
  return COMPUTED_TYPES.has(type);
}

const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'mirror',
  'auto_number',
  'item_id',
  'subtasks',
  'name',
  'creation_log',
  'last_updated',
  'progress',
  'dependency',
  'button',
  'doc',
  'file',
  'integration',
  'time_tracking',
]);

export interface CopyOptions {
  /**
   * Columns to leave empty on the copy even though they are writable.
   *
   * The engine's own status column belongs here: carrying a stale GEREED across would
   * make a fresh test item look like it had already been computed.
   */
  skipColumnIds?: readonly string[];
}

export function buildCopyPayload(
  cells: readonly SourceCell[],
  { skipColumnIds = [] }: CopyOptions = {}
): CopyPayload {
  const skipIds = new Set(skipColumnIds);
  const values: Record<string, unknown> = {};
  const skipped: CopyPayload['skipped'] = [];
  const unreadable: string[] = [];

  for (const cell of cells) {
    if (skipIds.has(cell.id)) {
      skipped.push({ columnId: cell.id, reason: 'expliciet overgeslagen' });
      continue;
    }
    if (COMPUTED_TYPES.has(cell.type)) {
      // Only worth reporting when it actually held something.
      if ((cell.value ?? '') !== '' || (cell.linked_item_ids?.length ?? 0) > 0) {
        skipped.push({ columnId: cell.id, reason: `${cell.type}: door Monday berekend` });
      }
      continue;
    }

    if (cell.type === 'board_relation') {
      /**
       * ABSENT is not empty. `linked_item_ids` is missing when the projection did not
       * ask for the `BoardRelationValue` fragment — which is this module's original bug
       * wearing a different hat: coercing it to `[]` drops every link and reports a
       * clean copy. Only an explicit `[]` or `null` means "links nothing".
       */
      if (cell.linked_item_ids === undefined) {
        unreadable.push(cell.id);
        continue;
      }
      // NEVER `cell.value` here — it is null even for a populated relation.
      const ids = (cell.linked_item_ids ?? []).map(Number).filter(Number.isInteger);
      if (ids.length > 0) {
        values[cell.id] = { item_ids: ids };
      }
      continue;
    }

    if (cell.value === null || cell.value === undefined || cell.value === 'null') {
      continue;
    }
    try {
      values[cell.id] = JSON.parse(cell.value);
    } catch {
      // A shape we do not know. Pretending the column was empty would make the copy
      // quietly wrong, so this is a failure the caller must act on, not a decision.
      unreadable.push(cell.id);
    }
  }

  return { values, skipped, unreadable };
}

/**
 * Which columns differ between a source item and its copy, ignoring what we chose not
 * to copy.
 *
 * Compared on the RENDERED value, not the raw JSON, because `value` carries server-side
 * metadata that legitimately differs between an original and a copy: Monday stamps
 * `override_all_ids` onto a dropdown it was told to set, and status values carry a
 * `changed_at`. Diffing the JSON reports those as differences, and a check that cries
 * wolf on every correct copy is worse than no check — it teaches you to ignore it.
 *
 * Relations are the exception in the other direction: their text is unreliable, so they
 * are compared on the linked ids, which is also the only place their content lives.
 */
export function diffCells(
  source: readonly SourceCell[],
  copy: readonly SourceCell[],
  { skipColumnIds = [] }: CopyOptions = {}
): string[] {
  const skipIds = new Set(skipColumnIds);
  const byId = new Map(copy.map((c) => [c.id, c]));
  const shape = (c: SourceCell | undefined): string => {
    if (c === undefined) {
      return '(kolom afwezig)';
    }
    if (c.type !== 'board_relation') {
      return c.text ?? '';
    }
    // Same distinction as the payload builder: a relation whose fragment was never
    // requested must not compare equal to one that genuinely links nothing, or the
    // read-back cheerfully approves a copy that lost every link.
    return c.linked_item_ids === undefined
      ? '(relatie niet opgevraagd)'
      : [...(c.linked_item_ids ?? [])].sort().join(',');
  };

  return source
    .filter((s) => !skipIds.has(s.id) && !COMPUTED_TYPES.has(s.type))
    .filter((s) => shape(s) !== shape(byId.get(s.id)))
    .map((s) => s.id);
}

export interface SchemaColumn {
  id: string;
  type: string;
  settings_str?: string | null;
}

/**
 * The part of a column's settings that CHANGES WHAT A VALUE MEANS.
 *
 * Id and type are not enough for four of them, and each fails differently:
 *
 * | `board_relation` | points at another board → the link means something else       |
 * | `dropdown`       | different label ids → `{ids:[19]}` selects a different option |
 * | `status`         | different indices → `{index:1}` renders a different label     |
 * | `mirror`         | re-sourced → the engine reads the wrong klant                 |
 *
 * The mirror is the one that cannot be caught afterwards: `diffCells` skips computed
 * types, so a re-sourced klant would be declared identical and only surface as a training
 * quietly attached to the wrong company.
 *
 * Only the semantic keys are compared — never the whole `settings_str`, which also holds
 * colours, positions and `hide_footer`. Those differ for cosmetic reasons and blocking a
 * copy over a label colour is how a check earns its way onto the ignore list.
 *
 * A RESULT, not a sentinel: a sentinel compares equal to itself, so two unreadable
 * configurations would agree with each other and pass a check that promises to fail closed.
 */
export type SettingsFingerprint =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const relationSettings = z.object({ boardIds: z.array(z.union([z.string(), z.number()])).min(1) });
const dropdownSettings = z.object({
  labels: z.array(z.object({ id: z.union([z.string(), z.number()]), name: z.string() })),
});
const statusSettings = z.object({ labels: z.record(z.string(), z.string()) });
const mirrorSettings = z.object({
  relation_column: z.record(z.string(), z.unknown()),
  displayed_linked_columns: z.record(z.string(), z.array(z.string())),
});

/** Types whose settings decide what a written value MEANS. Others need only id + type. */
const SEMANTIC_TYPES: ReadonlySet<string> = new Set([
  'board_relation',
  'dropdown',
  'status',
  'mirror',
]);

const canon = (value: unknown): string => JSON.stringify(value);

export function semanticSettings(column: SchemaColumn): SettingsFingerprint {
  if (!SEMANTIC_TYPES.has(column.type)) {
    return { ok: true, value: '' };
  }
  if (column.settings_str === null || column.settings_str === undefined) {
    return { ok: false, reason: 'geen settings' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(column.settings_str);
  } catch {
    return { ok: false, reason: 'settings niet te lezen' };
  }

  if (column.type === 'board_relation') {
    const result = relationSettings.safeParse(parsed);
    return result.success
      ? { ok: true, value: canon([...result.data.boardIds].map(String).sort()) }
      : { ok: false, reason: 'geen boardIds in de settings' };
  }
  if (column.type === 'dropdown') {
    const result = dropdownSettings.safeParse(parsed);
    return result.success
      ? {
          ok: true,
          value: canon(
            result.data.labels.map((l) => [String(l.id), l.name]).sort((a, b) => a[0].localeCompare(b[0]))
          ),
        }
      : { ok: false, reason: 'geen leesbare opties in de settings' };
  }
  if (column.type === 'status') {
    const result = statusSettings.safeParse(parsed);
    return result.success
      ? { ok: true, value: canon(Object.entries(result.data.labels).sort((a, b) => a[0].localeCompare(b[0]))) }
      : { ok: false, reason: 'geen leesbare labels in de settings' };
  }
  const result = mirrorSettings.safeParse(parsed);
  return result.success
    ? {
        ok: true,
        value: canon([
          Object.keys(result.data.relation_column).sort(),
          Object.entries(result.data.displayed_linked_columns).sort((a, b) => a[0].localeCompare(b[0])),
        ]),
      }
    : { ok: false, reason: 'spiegel verwijst nergens leesbaar naar' };
}

/**
 * The two boards have the same shape — checked over the SOURCE SCHEMA, not over the
 * values this particular item happens to carry.
 *
 * Iterating the payload was the obvious version and misses the quiet half: a column that
 * is EMPTY on this item contributes no value, so a target missing that column sails
 * through — until the next item, which has it filled. The schema is the thing that must
 * match; one item is only today's sample of it.
 */
export function assertSchemasAgree(
  source: { columns: readonly SchemaColumn[]; name: string },
  target: { columns: readonly SchemaColumn[]; name: string }
): void {
  const targetById = new Map(target.columns.map((c) => [c.id, c]));

  /**
   * EVERY source column, including the ones whose values we deliberately do not copy.
   *
   * Not copying a value and not needing the column are different things. The engine
   * WRITES its verdict to the recommendation status column — which is on the skip list
   * precisely so a stale verdict does not travel — and it READS the klant through a
   * mirror, which is a computed type. A target missing either passes a
   * "validate what we write" check and then cannot process the fixture at all.
   */
  const problems = source.columns.flatMap((c) => {
    const other = targetById.get(c.id);
    if (other === undefined) {
      return [`${c.id} (${c.type}) bestaat niet op het doelbord`];
    }
    if (other.type !== c.type) {
      return [`${c.id} is '${other.type}' op het doelbord maar '${c.type}' op de bron`];
    }
    // Judged INDEPENDENTLY on each side, so two unreadable configurations cannot agree
    // with each other and slip through.
    const mine = semanticSettings(c);
    const theirs = semanticSettings(other);
    if (!mine.ok) {
      return [`${c.id} (${c.type}) op de bron: ${mine.reason}`];
    }
    if (!theirs.ok) {
      return [`${c.id} (${c.type}) op het doelbord: ${theirs.reason}`];
    }
    if (mine.value === theirs.value) {
      return [];
    }
    // A relation says WHERE it points, which is the actionable half. The others would
    // print their whole label map, so they say what is wrong rather than dumping it.
    return c.type === 'board_relation'
      ? [`${c.id} verwijst naar ${theirs.value} op het doelbord en naar ${mine.value} op de bron`]
      : [`${c.id} (${c.type}) is anders ingesteld op het doelbord dan op de bron`];
  });

  if (problems.length > 0) {
    throw new Error(
      `De borden komen niet overeen, er wordt niets aangemaakt:\n  - ${problems.join('\n  - ')}\n` +
        `Kopieer naar een bord met dezelfde opzet als "${source.name}" (doel: ${target.name}).`
    );
  }
}
