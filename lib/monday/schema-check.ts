import type { ExpectedColumn } from './board-config';
import type { BoardMeta } from './graphql-client';
import type { Anomaly } from './validate';

/**
 * Stage-1 schema-drift guard + Stage-2 mass-drop guard.
 *
 * If a relation column is retyped, its `linked_item_ids` vanish, the decoder
 * returns `[]`, and reconciliation would DELETE the existing junctions as if the
 * relation were empty. So every configured column id + type is checked before
 * decoding. And a board silently reduced to (near) zero is still "complete +
 * coherent" against its own `items_count` — so totals are compared to the
 * previous run and a substantial drop is fatal unless acknowledged.
 */

const stripWs = (s: string): string => s.replace(/\s+/g, '');

/** Throw on any missing/retyped/re-sourced configured column (schema drift → fatal). */
export function assertColumns(board: BoardMeta, expected: readonly ExpectedColumn[]): void {
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  const problems: string[] = [];
  for (const e of expected) {
    const col = byId.get(e.id);
    if (col === undefined) {
      problems.push(`missing column ${e.id}`);
      continue;
    }
    if (col.type !== e.type) {
      problems.push(`column ${e.id} is type '${col.type}', expected '${e.type}'`);
    }
    if (e.settingsIncludes && e.settingsIncludes.length > 0) {
      const settings = stripWs(col.settings_str ?? '');
      for (const needle of e.settingsIncludes) {
        if (!settings.includes(stripWs(needle))) {
          problems.push(`column ${e.id} settings missing '${needle}' (repointed/re-sourced?)`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`schema drift on board ${board.id} (${board.name}): ${problems.join('; ')}`);
  }
}

export const DEFAULT_DROP_FACTOR = 0.5;

/**
 * Compare per-key counts (board totals AND artifact section counts) with the
 * previous successful run. A key whose count fell below `dropFactor` of last time
 * (default 50%) is fatal — UNLESS the run-specific approval `expected[key]`
 * matches the EXACT transition (`from` = previous, `to` = current). Binding to
 * both endpoints makes the approval one-shot: a later recurrence with a different
 * baseline no longer matches and is fatal again.
 */
export function checkSourceDrop(
  current: Record<string, number | null>,
  previous: Record<string, number | null> | null,
  expected: Record<string, { from: number; to: number }> = {},
  dropFactor: number = DEFAULT_DROP_FACTOR
): Anomaly | null {
  if (!previous) {
    return null;
  }
  const approved: string[] = [];
  const unapproved: string[] = [];
  for (const [key, prev] of Object.entries(previous)) {
    const now = current[key];
    if (
      typeof prev === 'number' &&
      prev > 0 &&
      typeof now === 'number' &&
      now < prev * dropFactor
    ) {
      const label = `${key}: ${prev} → ${now}`;
      const approval = expected[key];
      if (approval && approval.from === prev && approval.to === now) {
        approved.push(label);
      } else {
        unapproved.push(label);
      }
    }
  }
  if (approved.length === 0 && unapproved.length === 0) {
    return null;
  }
  const isFatal = unapproved.length > 0;
  return {
    kind: 'source_drop',
    severity: isFatal ? 'fatal' : 'allowed',
    detail: isFatal
      ? `board totals dropped without a matching approval (${unapproved.join(', ')})`
      : `board totals dropped as acknowledged (${approved.join(', ')})`,
    ids: isFatal ? unapproved : approved,
  };
}
