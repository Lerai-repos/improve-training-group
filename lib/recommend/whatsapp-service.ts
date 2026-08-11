import { z } from 'zod';

import { whatsappColumnsFor, type WhatsappColumn } from '@lib/monday/board-config';

import { ADDRESS_PROMPT_VERSION } from './address';
import {
  checkWhatsappColumns,
  formatWhatsappMessage,
  toTrainingDetails,
  type ColumnDiagnostic,
  type ObservedColumn,
} from './whatsapp';
import { validateText, type SavedMessage, type WhatsappStore } from './whatsapp-store';

import type { CityStore } from './city-store';
import type { ItemBoardReader } from './item-board';
import type { KvStore } from './kv';

/**
 * Generating and storing one training's WhatsApp message.
 *
 * Server-side, and in its own route that is **never polled** — which is the whole reason
 * a Monday read is affordable here. The item view polls its main endpoint every few
 * seconds; putting a column read behind that would have needed its own cache and
 * single-flight, the subsystem the workload scan already required.
 */

export interface TrainingRead {
  itemName: string | null;
  boardId: string | null;
  /** Column id → text (or `display_value` for mirrors and relations). */
  values: Map<string, string>;
  /** Which of the requested ids came back at all. */
  present: Set<string>;
  /** The board's own column metadata, for the drift check. */
  boardColumns: Map<string, ObservedColumn>;
}

export interface WhatsappTrainingReader {
  read(mondayItemId: string, columns: readonly WhatsappColumn[]): Promise<TrainingRead | null>;
}

interface QueryClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

const columnValueSchema = z.object({
  id: z.string(),
  type: z.string().nullish(),
  text: z.string().nullish(),
  display_value: z.string().nullish(),
});

const readSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string().nullish(),
        board: z
          .object({
            id: z.union([z.string(), z.number()]),
            columns: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.string().nullish(),
                  settings_str: z.string().nullish(),
                })
              )
              .nullish(),
          })
          .nullish(),
        column_values: z.array(columnValueSchema).nullish(),
      })
    )
    .nullish(),
});

/**
 * One item, its board's column metadata, and the message columns — in a single query.
 *
 * `board { id }` is validated inline rather than through a separate `ItemBoardReader`
 * hop, and `board { columns }` carries the `settings_str` the drift check needs. Two
 * round trips for one panel open would be two chances to be slow.
 */
export function parseWhatsappRead(raw: unknown, mondayItemId: string): TrainingRead | null {
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const item = (parsed.data.items ?? []).find((candidate) => String(candidate.id) === mondayItemId);
  if (item === undefined) {
    return null;
  }

  const values = new Map<string, string>();
  const present = new Set<string>();
  for (const column of item.column_values ?? []) {
    present.add(column.id);
    // Mirrors and relations return `text: null` and carry their content in
    // `display_value` — verified against all 756 live Agenda 2026 items.
    const value = column.display_value ?? column.text ?? '';
    if (value !== '') {
      values.set(column.id, value);
    }
  }

  const boardColumns = new Map<string, ObservedColumn>();
  for (const column of item.board?.columns ?? []) {
    boardColumns.set(column.id, {
      type: column.type ?? '',
      settingsStr: column.settings_str ?? null,
    });
  }

  return {
    itemName: item.name ?? null,
    boardId: item.board ? String(item.board.id) : null,
    values,
    present,
    boardColumns,
  };
}

export function createWhatsappTrainingReader(client: QueryClient): WhatsappTrainingReader {
  return {
    async read(mondayItemId, columns) {
      const ids = JSON.stringify(columns.map((column) => column.id));
      const doc = `query ($ids: [ID!]) {
        items(ids: $ids) {
          id
          name
          board { id columns { id type settings_str } }
          column_values(ids: ${ids}) {
            id
            type
            text
            ... on MirrorValue { display_value }
            ... on BoardRelationValue { display_value }
          }
        }
      }`;
      return parseWhatsappRead(await client.query<unknown>(doc, { ids: [mondayItemId] }), mondayItemId);
    },
  };
}

export interface WhatsappDeps {
  reader: WhatsappTrainingReader;
  store: WhatsappStore;
  cities: CityStore;
  boards: ItemBoardReader;
  kv: KvStore;
  /** The one Agenda board this feature serves. */
  boardId: string;
}

export interface WhatsappPayload {
  generated: string;
  saved: SavedMessage | null;
  token: string;
  /**
   * A value IS stored and could not be read.
   *
   * Distinct from `saved: null`, which is genuine absence. The panel needs the
   * difference: `Herstel origineel` is the only way to clear a corrupt record, and
   * treating it as "nothing stored" leaves it — and its warning — in place forever.
   */
  unreadable: boolean;
  warnings: string[];
}

export type WhatsappResult =
  | { status: 200; body: { success: true; data: WhatsappPayload } }
  | { status: 200; body: { success: true; data: { saved: SavedMessage | null; token: string } } }
  | { status: 403 | 404 | 409 | 422; body: { success: false; error: string; data?: unknown } };

/**
 * How long a verified item→board answer is trusted.
 *
 * Short, because it IS an authorization input: an item moved off the Agenda board stops
 * being writable within ten minutes. Long enough that the common path — open the panel,
 * type, autosave — costs no extra Monday call, because GET already learned the board for
 * free from the query it had to make anyway.
 */
export const BOARD_MEMO_TTL_MS = 10 * 60 * 1000;

/** A bounded budget for the cold lookup. See {@link authorizeItemBoard}. */
export const BOARD_LOOKUP_DEADLINE_MS = 5000;

const boardMemoKey = (mondayItemId: string): string => `board-of:${mondayItemId}`;

/**
 * Is this item on the board we serve?
 *
 * The CAS token is a concurrency device, not an authorization one — `absent` is
 * guessable by anyone — so every mutation answers this question independently. Without
 * it a `plan` holder could write records against arbitrary item ids.
 *
 * The memo is a note of a verified fact, not a capability grant: it caches the item's
 * board, and the comparison against `deps.boardId` is redone on every call.
 */
export async function authorizeItemBoard(
  deps: Pick<WhatsappDeps, 'boards' | 'kv' | 'boardId'>,
  mondayItemId: string
): Promise<boolean> {
  const memo = await deps.kv.get(boardMemoKey(mondayItemId)).catch(() => null);
  if (memo !== null) {
    return memo === deps.boardId;
  }
  const boardId = await deps.boards.readBoardId(mondayItemId);
  if (boardId === null) {
    // A nonexistent item, or one our token cannot see. Neither is writable.
    return false;
  }
  await rememberBoard(deps.kv, mondayItemId, boardId);
  return boardId === deps.boardId;
}

export async function rememberBoard(
  kv: KvStore,
  mondayItemId: string,
  boardId: string
): Promise<void> {
  // Best-effort: a memo that fails to write costs a Monday call, never correctness.
  await kv.set(boardMemoKey(mondayItemId), boardId, { ttlMs: BOARD_MEMO_TTL_MS }).catch(() => undefined);
}

const FIELD_LABELS: Record<string, string> = {
  datum: 'datum',
  thema: 'thema',
  themaRelation: "thema's",
  tijden: 'tijden',
  taal: 'taal',
  locatie: 'locatie',
  deelnemers: 'aantal deelnemers',
  trainers: 'aantal trainers',
  acteurs: 'aantal acteurs',
  klant: 'klant',
};

/** Which rendered line a configured column feeds. */
const LINE_OF: Record<string, string> = {
  themaRelation: 'thema',
};

/**
 * Some drifted columns have an untainted fallback — the free-text thema stands in for the
 * relation, the item name for the Bedrijf mirror — so the line is still there. Saying it
 * was left out would contradict the message sitting right beside the warning.
 */
function driftWarning(diagnostic: ColumnDiagnostic, rendered: boolean): string {
  const label = FIELD_LABELS[diagnostic.field] ?? diagnostic.field;
  const cause =
    diagnostic.reason === 'missing'
      ? 'ontbreekt op het board'
      : diagnostic.reason === 'type'
        ? 'heeft een ander kolomtype gekregen'
        : 'verwijst naar een ander board dan verwacht';
  const effect = rendered
    ? 'die bron is genegeerd; de regel komt uit een andere bron'
    : 'die regel is weggelaten';
  return `De kolom voor "${label}" (${diagnostic.columnId}) ${cause}; ${effect}.`;
}

export async function handleWhatsappGet(
  deps: WhatsappDeps,
  mondayItemId: string
): Promise<WhatsappResult> {
  const columns = whatsappColumnsFor(deps.boardId);
  const read = await deps.reader.read(mondayItemId, columns);
  if (read === null) {
    return { status: 404, body: { success: false, error: 'training not found' } };
  }
  if (read.boardId !== deps.boardId) {
    return { status: 403, body: { success: false, error: 'item is not on the agenda board' } };
  }
  // Learned for free here, so the autosaves that follow need no Monday call of their own.
  await rememberBoard(deps.kv, mondayItemId, read.boardId);

  const diagnostics = checkWhatsappColumns(read.present, read.boardColumns, columns);

  /**
   * The city is looked up against the LIVE location, so a location edited without a
   * recalculation simply misses and the message falls back to the raw text. A drifted
   * Locatie column contributes nothing at all, city included.
   */
  const locatieId = columns.find((column) => column.field === 'locatie')?.id;
  const locatieDrifted = diagnostics.some((diagnostic) => diagnostic.field === 'locatie');
  const rawLocation = locatieId === undefined || locatieDrifted ? null : (read.values.get(locatieId) ?? null);
  const city =
    rawLocation === null || rawLocation.trim() === ''
      ? null
      : await deps.cities.lookup(rawLocation, ADDRESS_PROMPT_VERSION);

  const details = toTrainingDetails(read.values, {
    itemName: read.itemName,
    city,
    specs: columns,
    diagnostics,
  });
  const message = formatWhatsappMessage(details);
  const snapshot = await deps.store.read(mondayItemId);

  /**
   * The unreadable record is reported by the `unreadable` FLAG, not as a sentence in
   * here. The panel has to be able to clear that one notice on recovery without
   * discarding the drift, missing-column and truncation warnings beside it — and it
   * cannot do that to an opaque string.
   */
  /**
   * What actually rendered — not the inverse of `omitted`, which deliberately excludes
   * the conditional trainer and actor lines. Inferring one from the other claimed a
   * drifted trainer column had been covered by a fallback that does not exist.
   */
  const rendered = new Set<string>(message.rendered);
  const warnings = [
    ...diagnostics.map((diagnostic) =>
      driftWarning(diagnostic, rendered.has(LINE_OF[diagnostic.field] ?? diagnostic.field))
    ),
    ...message.warnings,
    ...missingFieldWarning(message.omitted),
  ];

  return {
    status: 200,
    body: {
      success: true,
      data: {
        generated: message.text,
        saved: snapshot.saved,
        token: snapshot.token,
        unreadable: snapshot.unreadable,
        warnings,
      },
    },
  };
}

function missingFieldWarning(omitted: readonly string[]): string[] {
  if (omitted.length === 0) {
    return [];
  }
  const labels = omitted.map((field) => FIELD_LABELS[field] ?? field);
  return [`Niet ingevuld in Monday: ${labels.join(', ')}.`];
}

const saveBodySchema = z.object({
  edited: z.string(),
  base: z.string(),
  token: z.string().min(1),
});

const discardBodySchema = z.object({ token: z.string().min(1) });

export async function handleWhatsappSave(
  deps: WhatsappDeps,
  mondayItemId: string,
  body: unknown
): Promise<WhatsappResult> {
  const parsed = saveBodySchema.safeParse(body);
  if (!parsed.success) {
    return { status: 422, body: { success: false, error: 'edited, base and token are required' } };
  }
  const { edited, base, token } = parsed.data;

  // An edit trimmed to nothing is a revert, not a stored empty string.
  if (edited.trim() === '') {
    return handleWhatsappDiscard(deps, mondayItemId, { token });
  }

  const invalid = validateText(edited, base);
  if (invalid !== null) {
    return { status: 422, body: { success: false, error: invalid } };
  }
  if (!(await authorizeItemBoard(deps, mondayItemId))) {
    return { status: 403, body: { success: false, error: 'item is not on the agenda board' } };
  }

  const result = await deps.store.save(mondayItemId, { edited, base, token });
  return writeResult(result);
}

export async function handleWhatsappDiscard(
  deps: WhatsappDeps,
  mondayItemId: string,
  body: unknown
): Promise<WhatsappResult> {
  const parsed = discardBodySchema.safeParse(body);
  if (!parsed.success) {
    return { status: 422, body: { success: false, error: 'token is required' } };
  }
  if (!(await authorizeItemBoard(deps, mondayItemId))) {
    return { status: 403, body: { success: false, error: 'item is not on the agenda board' } };
  }

  return writeResult(await deps.store.discard(mondayItemId, parsed.data.token));
}

function writeResult(
  result: Awaited<ReturnType<WhatsappStore['save']>>
): WhatsappResult {
  if (result.kind === 'ok') {
    return { status: 200, body: { success: true, data: { saved: result.saved, token: result.token } } };
  }
  // The current record travels with the 409 so the panel can show what is really there
  // without a second round trip — and never has to discard the planner's draft to find out.
  return {
    status: 409,
    body: {
      success: false,
      error: 'the saved message changed since it was read',
      data: { saved: result.saved, token: result.token, unreadable: result.unreadable },
    },
  };
}
