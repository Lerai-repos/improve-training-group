import { z } from 'zod';

import type { Qualification } from '@lib/calc';
import { AGENDA_2026_COLUMNS, THEMA_QUAL_COLOURS } from '@lib/monday/board-config';

import type { LiveMondayReader, LiveTraining } from './service';
import type { QualObservation } from './types';

/**
 * Live Monday reads for the recommendation engine — the correctness-critical,
 * volatile inputs (the just-edited training + its themes' four qualification
 * colour columns). Uses the read-only GraphQL client (mutations are rejected).
 */

interface QueryClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

const columnSchema = z.object({
  id: z.string(),
  text: z.string().nullable().optional(),
  linked_item_ids: z.array(z.union([z.number(), z.string()])).optional(),
});
const itemsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      updated_at: z.string().nullable().optional(),
      column_values: z.array(columnSchema),
    })
  ),
});

const COLOURS: Qualification[] = ['groen', 'oranje', 'rood', 'grijs'];

/**
 * Parse a themes qualification response into observations. Fail closed: a
 * malformed response, a requested theme absent from the response, or a theme
 * missing one of the four colour columns all THROW — a read failure must never be
 * silently treated as "no green trainers" (→ GEEN MATCH).
 */
export function parseThemeQualifications(
  raw: unknown,
  requestedThemeIds: readonly string[]
): QualObservation[] {
  const parsed = itemsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `readThemeQualifications: malformed response for themes ${requestedThemeIds.join(',')}`
    );
  }
  const returned = new Set(parsed.data.items.map((i) => i.id));
  const missingThemes = requestedThemeIds.filter((id) => !returned.has(id));
  if (missingThemes.length > 0) {
    throw new Error(
      `readThemeQualifications: incomplete read — missing theme(s) ${missingThemes.join(',')}`
    );
  }

  const observations: QualObservation[] = [];
  for (const item of parsed.data.items) {
    for (const colour of COLOURS) {
      const col = item.column_values.find((c) => c.id === THEMA_QUAL_COLOURS[colour]);
      if (!col) {
        throw new Error(
          `readThemeQualifications: theme ${item.id} missing colour column ${THEMA_QUAL_COLOURS[colour]}`
        );
      }
      // A relation column that returned no `linked_item_ids` field (vs an explicit
      // empty array) has drifted off BoardRelationValue — treating it as empty would
      // silently drop every trainer for the theme. Fail closed → FOUT.
      if (col.linked_item_ids === undefined) {
        throw new Error(
          `readThemeQualifications: theme ${item.id} colour column ${THEMA_QUAL_COLOURS[colour]} is not a relation (no linked_item_ids)`
        );
      }
      for (const trainerId of col.linked_item_ids) {
        observations.push({
          trainerExternalId: String(trainerId),
          themaExternalId: item.id,
          colour,
        });
      }
    }
  }
  return observations;
}

/** The four training columns read live (drift in any of these must not read as empty). */
export interface TrainingColumns {
  themaRelation: string;
  datum: string;
  duur: string;
  locatie: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DURATION_NUMBER = /^\d+([.,]\d+)?$/;

/**
 * A clean, complete duration number or null. `parseFloat` is deliberately avoided —
 * it accepts partial values ("4 uur" → 4, "4,5" → 4). A malformed value becomes
 * null so the service's validate_training stage fails it closed.
 */
function parseDuration(text: string | null): number | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!DURATION_NUMBER.test(trimmed)) {
    return null;
  }
  const n = Number.parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * A valid ISO calendar date (`YYYY-MM-DD`) or null. Any non-empty string used to
 * pass the blank-check and then satisfy the lexicographic rate-card comparison at
 * pricing; a real calendar-date check (round-tripped through UTC) closes that.
 */
function parseIsoDate(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const m = ISO_DATE.exec(text.trim());
  if (!m) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null; // e.g. 2026-13-45 or 2026-02-30
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Parse a training-item read into a {@link LiveTraining}. Fail closed: if a
 * requested column id is absent from the response (a column-id drift, or Monday
 * omitting it), throw — otherwise the theme relation could read as empty and the
 * training would finish a legitimate-looking GEEN MATCH. A malformed response
 * THROWS (a read failure must be diagnosable, not a generic not-found); null is
 * reserved for a valid but empty `items` array (the item genuinely isn't there).
 */
export function parseTrainingRead(raw: unknown, cols: TrainingColumns): LiveTraining | null {
  const parsed = itemsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('readTraining: malformed response');
  }
  if (parsed.data.items.length === 0) {
    return null;
  }
  const item = parsed.data.items[0];
  const byId = new Map(item.column_values.map((c) => [c.id, c]));
  const requestedColumns = [cols.themaRelation, cols.datum, cols.duur, cols.locatie];
  const missingColumns = requestedColumns.filter((id) => !byId.has(id));
  if (missingColumns.length > 0) {
    throw new Error(
      `readTraining: incomplete read for item ${item.id} — missing column(s) ${missingColumns.join(',')}`
    );
  }
  // The theme column must be a relation with a linked_item_ids payload (possibly an
  // explicit empty array). A missing payload means it drifted off BoardRelationValue
  // and would read as a false zero-theme GEEN MATCH → fail closed.
  const themaCol = byId.get(cols.themaRelation);
  if (!themaCol || themaCol.linked_item_ids === undefined) {
    throw new Error(
      `readTraining: theme column ${cols.themaRelation} is not a relation (no linked_item_ids)`
    );
  }
  return {
    externalItemId: item.id,
    themeExternalIds: themaCol.linked_item_ids.map(String),
    locatie: byId.get(cols.locatie)?.text ?? null,
    datum: parseIsoDate(byId.get(cols.datum)?.text ?? null),
    duurTraining: parseDuration(byId.get(cols.duur)?.text ?? null),
    updatedAt: item.updated_at ?? '',
  };
}

export function createMondayReader(client: QueryClient): LiveMondayReader {
  const { themaRelation, datum, duur, locatie } = AGENDA_2026_COLUMNS;

  return {
    async readTraining(itemId: string): Promise<LiveTraining | null> {
      const cols = JSON.stringify([themaRelation, datum, duur, locatie]);
      const doc = `query ($ids: [ID!]) { items(ids: $ids) { id updated_at column_values(ids: ${cols}) { id text ... on BoardRelationValue { linked_item_ids } } } }`;
      const raw = await client.query<unknown>(doc, { ids: [itemId] });
      return parseTrainingRead(raw, { themaRelation, datum, duur, locatie });
    },

    async readThemeQualifications(themeExternalIds: readonly string[]): Promise<QualObservation[]> {
      if (themeExternalIds.length === 0) {
        return [];
      }
      const colIds = JSON.stringify(COLOURS.map((c) => THEMA_QUAL_COLOURS[c]));
      const doc = `query ($ids: [ID!]) { items(ids: $ids) { id column_values(ids: ${colIds}) { id ... on BoardRelationValue { linked_item_ids } } } }`;
      const raw = await client.query<unknown>(doc, { ids: [...themeExternalIds] });
      return parseThemeQualifications(raw, themeExternalIds);
    },
  };
}
