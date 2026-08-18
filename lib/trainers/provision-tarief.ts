/**
 * Put `Uurtarief` and `Datum instroom` on the Trainers board, and seed the rate for the
 * trainers whose group still says which cohort they belong to.
 *
 * ## Why the seeding is urgent and the column is not
 *
 * ITG is about to reorganise the trainer groups (Dirkje, 18-Aug-2026): Schaduwpool stays
 * separate, acteurs and a blacklist all become "inactief". Right now `Trainers instroom
 * 2020-2024` and `Trainers instroom 2024 - Heden` are the only record of who is on which
 * rate. After the reorg that record is gone, and the existing `Tariefconstructie` columns
 * cannot replace it: there are three of them, one is a SharePoint link, and between them
 * they cover 68 of 187 trainers.
 *
 * So this runs before the reorg or not at all.
 *
 * ## Run it BEFORE deploying the reader
 *
 * `TRAINER_RATE_COLUMNS` makes `itg_uurtarief` a required column, and `assertTrainerColumns`
 * throws per item when a required column is missing. Deploying that first would FOUT every
 * training until the column exists. Columns first, deploy second. Between the two the
 * running engine simply never asks for the column, so there is no window where anything
 * misbehaves.
 */

import { TRAINERS_BOARD, TRAINER_EXPECTED_COLUMNS } from '@lib/monday/board-config';
import { assertColumns } from '@lib/monday/schema-check';

import { planTarief } from './tarief-plan';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';
import type { TariefPlan, TrainerRow } from './tarief-plan';

export const UURTARIEF_COLUMN = 'itg_uurtarief';
export const DATUM_INSTROOM_COLUMN = 'itg_datum_instroom';

const UURTARIEF_TITLE = 'Uurtarief';
const DATUM_INSTROOM_TITLE = 'Datum instroom';

const UURTARIEF_DESCRIPTION =
  'Uurtarief in euro, exclusief reiskosten. Dit is een tarief PER UUR, niet per dagdeel. ' +
  'Laat leeg om het groepstarief uit het Instellingen-bord te gebruiken.';
const DATUM_INSTROOM_DESCRIPTION =
  'Maand waarin deze trainer is ingestroomd. Monday wil een volledige datum, kies de 1e ' +
  'van de maand. Alleen ter administratie; het systeem rekent hier niet mee.';

/**
 * Idempotency prefix, board id included.
 *
 * Monday remembers a key for 30 minutes. Without the board in the key, a run against a
 * duplicate trainers board would replay the production response and report success having
 * written nothing.
 */
export function tariefKeyPrefix(boardId: string): string {
  return `tarief:${boardId}`;
}

/**
 * Refuse to write production rates that were read from somewhere else.
 *
 * There is no `MONDAY_TRAINERS_BOARD_ID`, so the target is always ITG's live trainers
 * board. The Instellingen board IS overridable outside Vercel production, deliberately,
 * for preview and local work. With that override set, this command would read a preview
 * board's tariffs and write them onto real trainers — and nothing downstream could catch
 * it, because the numbers it produces are perfectly well-formed. The two boards have to
 * describe one environment, and only one of them can move.
 *
 * Lives here rather than in the CLI so a second caller cannot forget it.
 */
export function assertSettingsMatchTarget(input: {
  settingsBoardId: string;
  productionSettingsBoardId: string;
  targetBoardId: string;
}): void {
  if (input.targetBoardId !== TRAINERS_BOARD) {
    // Not the production trainers board, so a non-production settings board is coherent.
    return;
  }
  if (input.settingsBoardId === input.productionSettingsBoardId) {
    return;
  }
  throw new Error(
    `De instellingen komen van board ${input.settingsBoardId}, niet van het productiebord ` +
      `${input.productionSettingsBoardId}, terwijl dit naar het echte trainersbord ` +
      `(${input.targetBoardId}) schrijft. Haal MONDAY_INSTELLINGEN_BOARD_ID uit je omgeving ` +
      'voordat je dit draait.'
  );
}

export interface ProvisionTariefDeps {
  read: MondayGraphQLClient;
  write: MondayMutationClient;
  boardId: string;
  keyPrefix: string;
  apply: boolean;
  /** Cohort group id → euro amount, resolved by the caller from the live rate cards. */
  euroByGroup: ReadonlyMap<string, string>;
  log?: (line: string) => void;
}

export interface ProvisionTariefResult {
  readonly createdColumns: readonly string[];
  readonly plan: TariefPlan;
  readonly written: number;
  readonly trainersRead: number;
}

interface RawTrainerItem {
  id: string;
  name: string;
  updated_at?: string | null;
  group?: { id?: string | null; title?: string | null } | null;
  column_values?: ReadonlyArray<{ id: string; text?: string | null }>;
}

/**
 * Create one column, or confirm the right one is already there.
 *
 * A column that exists with the WRONG type is refused rather than replaced: the only fix
 * is destructive, and doing it silently would throw away whatever is in it.
 */
async function ensureColumn(
  deps: ProvisionTariefDeps,
  spec: { id: string; title: string; type: 'numbers' | 'date'; description: string },
  present: ReadonlySet<string>,
  existingType: string | undefined,
  created: string[]
): Promise<void> {
  if (present.has(spec.id)) {
    if (existingType !== spec.type) {
      throw new Error(
        `Kolom ${spec.id} bestaat al maar is type '${existingType ?? '?'}', verwacht '${spec.type}'. ` +
          'Corrigeer dit met de hand; dit script overschrijft geen bestaande kolom.'
      );
    }
    return;
  }

  created.push(`${spec.title} (${spec.id}, ${spec.type})`);
  if (!deps.apply) {
    return;
  }

  await deps.write.mutate(
    `mutation ($board: ID!, $id: String, $title: String!, $type: ColumnType!, $description: String) {
       create_column(board_id: $board, id: $id, title: $title, column_type: $type, description: $description) { id }
     }`,
    {
      board: deps.boardId,
      id: spec.id,
      title: spec.title,
      type: spec.type,
      /**
       * The description is the only place the per-uur rule is visible to whoever edits
       * this cell, and it is the mistake most likely to be made. Monday renders it as an
       * info marker on the column header.
       */
      description: spec.description,
    },
    { idempotencyKey: `${deps.keyPrefix}:column:${spec.id}` }
  );
}

/**
 * Every trainer, with the `Uurtarief` cell only when that column actually exists.
 *
 * The conditional projection is not a nicety. Monday omits a column id it does not
 * recognise instead of erroring, so asking for `itg_uurtarief` before it exists returns
 * the same shape as an empty cell — and this command would then be unable to tell "the
 * column is not there yet" from "nobody has filled it in". On a dry run before creation
 * those happen to mean the same thing; after creation they very much do not.
 */
async function readTrainers(
  deps: ProvisionTariefDeps,
  hasColumn: boolean,
  itemsCount: number | null
): Promise<TrainerRow[]> {
  const projection = hasColumn
    ? `id name updated_at group { id title } column_values(ids: ["${UURTARIEF_COLUMN}"]) { id text }`
    : 'id name updated_at group { id title }';

  const items = await deps.read.fetchBoardItems<RawTrainerItem>(
    deps.boardId,
    projection,
    itemsCount
  );

  return items.map((item) => {
    const cell = (item.column_values ?? []).find((c) => c.id === UURTARIEF_COLUMN);

    /**
     * When we asked for the column, it must come BACK — an empty value is fine, an
     * absent one is not.
     *
     * Monday omits a column it does not recognise instead of erroring, so a renamed
     * column or a partial payload arrives looking exactly like an empty cell. That is
     * the one input that turns this command destructive: the trainer reads as unset, the
     * plan writes the cohort rate, and somebody's personal €125 is gone. Refusing costs
     * a re-run; guessing costs a rate nobody will notice is wrong.
     */
    if (hasColumn && cell === undefined) {
      throw new Error(
        `Trainer ${item.id} (${item.name}) levert geen ${UURTARIEF_COLUMN} terug terwijl de ` +
          'kolom bestaat. Een ontbrekende kolomwaarde is niet hetzelfde als een lege, en ' +
          'doorgaan zou een bestaand tarief kunnen overschrijven.'
      );
    }

    return {
      itemId: String(item.id),
      naam: item.name,
      groupId: item.group?.id ?? null,
      groupTitle: item.group?.title ?? '(zonder groep)',
      uurtarief: hasColumn ? (cell?.text ?? null) : null,
    };
  });
}

export async function provisionTarief(deps: ProvisionTariefDeps): Promise<ProvisionTariefResult> {
  const log = deps.log ?? (() => {});

  /**
   * Refuse to touch anything that is not the Trainers board.
   *
   * `create_column` is happy to add a stray `Uurtarief` to whatever id it is handed, and
   * the signature check is two API calls cheaper than explaining it afterwards. The new
   * columns are deliberately NOT part of this assertion: they are what we are here to
   * create.
   */
  const [meta] = await deps.read.getSchema([deps.boardId]);
  if (meta === undefined) {
    throw new Error(`Board ${deps.boardId} niet gevonden of niet toegankelijk`);
  }
  assertColumns(meta, TRAINER_EXPECTED_COLUMNS);

  const present = new Set(meta.columns.map((c) => c.id));
  const typeById = new Map(meta.columns.map((c) => [c.id, c.type]));
  const createdColumns: string[] = [];

  await ensureColumn(
    deps,
    {
      id: UURTARIEF_COLUMN,
      title: UURTARIEF_TITLE,
      type: 'numbers',
      description: UURTARIEF_DESCRIPTION,
    },
    present,
    typeById.get(UURTARIEF_COLUMN),
    createdColumns
  );
  await ensureColumn(
    deps,
    {
      id: DATUM_INSTROOM_COLUMN,
      title: DATUM_INSTROOM_TITLE,
      type: 'date',
      description: DATUM_INSTROOM_DESCRIPTION,
    },
    present,
    typeById.get(DATUM_INSTROOM_COLUMN),
    createdColumns
  );

  const columnReadable = present.has(UURTARIEF_COLUMN) || deps.apply;
  const rows = await readTrainers(deps, columnReadable, meta.items_count);
  const plan = planTarief(rows, deps.euroByGroup);

  log(
    `${rows.length} trainers gelezen · ${plan.writes.length} te vullen · ` +
      `${plan.alreadySet.length} al ingevuld · ` +
      `${plan.noCohort.reduce((n, g) => n + g.count, 0)} zonder cohort`
  );

  if (!deps.apply) {
    return { createdColumns, plan, written: 0, trainersRead: rows.length };
  }

  let written = 0;
  for (const write of plan.writes) {
    await deps.write.mutate(
      `mutation ($board: ID!, $item: ID!, $values: JSON!) {
         change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
       }`,
      {
        board: deps.boardId,
        item: write.itemId,
        values: JSON.stringify({ [UURTARIEF_COLUMN]: write.euros }),
      },
      // Per ITEM, so a resumed run does not replay one trainer's write onto the next.
      { idempotencyKey: `${deps.keyPrefix}:value:${write.itemId}` }
    );
    written += 1;
  }

  /**
   * Read back through the same path, and compare against what we set out to write.
   *
   * Monday answers a complexity refusal with HTTP 200, and `change_multiple_column_values`
   * returns an id whether or not the value landed. Counting our own successful calls
   * proves nothing; re-reading the board does.
   */
  const after = await readTrainers(deps, true, meta.items_count);
  const byId = new Map(after.map((r) => [r.itemId, r.uurtarief]));
  const missed = plan.writes.filter((w) => (byId.get(w.itemId) ?? '').trim() === '');
  if (missed.length > 0) {
    throw new Error(
      `${missed.length} van de ${plan.writes.length} tarieven staan na het schrijven nog leeg: ` +
        missed
          .slice(0, 5)
          .map((m) => m.naam)
          .join(', ')
    );
  }

  return { createdColumns, plan, written, trainersRead: rows.length };
}

/** The production trainers board, for the command's own safety check. */
export const TRAINERS_PRODUCTION_BOARD = TRAINERS_BOARD;
