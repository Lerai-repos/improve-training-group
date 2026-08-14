import { z } from 'zod';

import { assertColumns } from '@lib/monday/schema-check';

import { activeOptionIds, deriveOptionMap, selectedGroupIds } from './groepen';
import { isKnownName, normaliseName, resolveSetting } from './keys';

import type { ConfigRowLike } from '@lib/config';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { ExpectedColumn } from '@lib/monday/board-config';
import type { DropdownLabel, DropdownSelection } from './groepen';

/**
 * Read the Instellingen board.
 *
 * Fail-closed throughout: this is the engine path, where QStash retries and a terminal
 * FOUT makes every problem visible on the board. The one thing that must NEVER happen
 * is a *plausible* answer built from partial data — a missing row silently defaulted, a
 * page quietly dropped — because that produces wrong prices with nothing to see.
 */

/**
 * Pinned custom ids, created by `instellingen:create`.
 *
 * Ids, not titles: titles are editable by everyone with board access, and keying the
 * config reader on a mutable name is the mistake this codebase has already rejected for
 * agenda columns. A rename is then harmless, which is the point.
 */
export const SETTINGS_EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { id: 'itg_waarde', type: 'text' },
  { id: 'itg_categorie', type: 'status' },
  { id: 'itg_omschrijving', type: 'text' },
];

const VALUE_COLUMN = 'itg_waarde';

/** The dropdown that owns the trainer-group selection. Absent before the migration. */
export const GROEPEN_COLUMN = 'itg_groepen';

const TRAINERGROEPEN = normaliseName('TRAINERGROEPEN');
/** The config key that row owns. Its value is built from the dropdown, not from `Waarde`. */
const GROUPS_KEY = 'RECOMMENDABLE_TRAINER_GROUPS';

const duplicateMessage = (name: string): string =>
  `"${name}" staat meerdere keren op het Instellingen-board — ` +
  'twee rijen die elkaar tegenspreken is erger dan geen rij';

/**
 * `updated_at` is NOT optional decoration.
 *
 * `fetchBoardItems` derives its *after* coherence inventory from these very items
 * rather than paginating a third time, so omitting `updated_at` makes every row compare
 * as changed and every read fail — a total outage caused by a tidied-up projection.
 *
 * `group { id }` is equally load-bearing: it is how a note is told from a setting, and
 * it has to be right from the instant an item is created.
 *
 * The dropdown is asked for only when the board HAS it, so a pre-migration board is
 * queried exactly as it was before this existed. Its selections arrive through the typed
 * `DropdownValue` fragment rather than as `text`: `text` is a comma-joined list of label
 * NAMES, and a group title containing a comma would split into garbage.
 */
function itemFields(hasGroepen: boolean): string {
  const ids = hasGroepen ? `"${VALUE_COLUMN}", "${GROEPEN_COLUMN}"` : `"${VALUE_COLUMN}"`;
  const selected = hasGroepen ? ' ... on DropdownValue { values { id label } }' : '';
  return `id name updated_at group { id } column_values(ids: [${ids}]) { id text${selected} }`;
}

interface SettingsCell {
  id: string;
  text?: string | null;
  /** Present only on the dropdown, via the typed `DropdownValue` fragment. */
  values?: DropdownSelection[] | null;
}

interface SettingsItem {
  id: string;
  name: string;
  updated_at?: string | null;
  group?: { id: string } | null;
  column_values?: SettingsCell[] | null;
}

export interface SettingsBoardConfig {
  boardId: string;
  /**
   * Generated per board, so it travels WITH the board id rather than being a single
   * pinned production value — the preview board has a different one.
   */
  notitiesGroupId: string;
  /**
   * Pinned option id → group id for the `Groepen` dropdown.
   *
   * Optional because it cannot exist before the migration that creates the column and
   * discovers Monday's generated ids. While it is absent, identity is DERIVED from the
   * labels; once pinned, the label text stops being trusted at all.
   */
  groepenOptions?: ReadonlyMap<string, string>;
}

export interface RawSettings {
  appRows: ConfigRowLike[];
  /** rateKey → hourly rate in cents. Turned into cards by `rates.ts`. */
  rateCents: Map<string, number>;
  /**
   * The row exists but nothing is selected — deliberately distinct from the row being
   * absent, so the error can say which of the two it is to whoever has to fix it.
   */
  emptyGroupSelection: boolean;
}

function cellOf(item: SettingsItem, columnId: string): SettingsCell | undefined {
  return (item.column_values ?? []).find((c) => c.id === columnId);
}

function valueOf(item: SettingsItem): string {
  return cellOf(item, VALUE_COLUMN)?.text ?? '';
}

/**
 * The dropdown's complete option list, from the column's TYPED settings.
 *
 * A second request, because the item's `values` carries only what is SELECTED on that
 * item and therefore can never prove that an unselected option still exists — nor
 * whether a selected one has since been deactivated, which a pinned map cannot know
 * either. `settings_str` is deprecated as of API 2025-10; this is its typed replacement.
 */
const groepenSettingsSchema = z.object({
  boards: z
    .array(
      z.object({
        columns: z.array(
          z.object({
            settings: z.object({
              labels: z.array(
                z.object({
                  id: z.union([z.number(), z.string()]),
                  label: z.string(),
                  is_deactivated: z.boolean().nullish(),
                })
              ),
            }),
          })
        ),
      })
    )
    .nonempty(),
});

export async function fetchGroepenLabels(
  client: MondayGraphQLClient,
  boardId: string
): Promise<DropdownLabel[]> {
  const raw = await client.query<unknown>(
    `query ($board: ID!) {
       boards(ids: [$board]) { columns(ids: ["${GROEPEN_COLUMN}"]) { id settings } }
     }`,
    { board: boardId }
  );

  const parsed = groepenSettingsSchema.safeParse(raw);
  const labels = parsed.success ? parsed.data.boards[0].columns[0]?.settings.labels : undefined;
  if (labels === undefined) {
    throw new Error(
      `Kon de opties van de kolom Groepen op board ${boardId} niet lezen — ` +
        'zonder de optielijst is niet vast te stellen welke groepen gekozen zijn'
    );
  }
  return labels;
}

/**
 * How a selected option becomes a group id, for whichever deploy this is.
 *
 * BEFORE the map is pinned there is nothing else to go on, so identity is derived from
 * the labels and `deriveOptionMap`'s refusals are load-bearing: without a coherent set
 * there is no trustworthy way to resolve an id at all.
 *
 * AFTER it is pinned, only the SELECTED options are judged. An extra or retired option
 * nobody has chosen cannot change an answer, and taking recommendations down because
 * someone tidied the dropdown would be the engine-path equivalent of a false alarm.
 * Drift of the whole set is checked where it can be acted on: provisioning and preflight.
 */
async function resolveGroepen(
  client: MondayGraphQLClient,
  boardId: string,
  pinned: ReadonlyMap<string, string> | undefined,
  values: readonly DropdownSelection[]
): Promise<string[]> {
  const labels = await fetchGroepenLabels(client, boardId);
  const map = pinned ?? deriveOptionMap(labels);
  return selectedGroupIds(values, map, activeOptionIds(labels));
}

export async function readSettings(
  client: MondayGraphQLClient,
  { boardId, notitiesGroupId, groepenOptions }: SettingsBoardConfig
): Promise<RawSettings> {
  const [meta] = await client.getSchema([boardId]);
  if (meta === undefined) {
    throw new Error(`Instellingen-board ${boardId} niet gevonden of niet toegankelijk`);
  }

  // Required ids with the expected types. Extra columns are IGNORED on purpose: on a
  // board everyone can edit, a helper column is ordinary and must not stop the engine.
  assertColumns(meta, SETTINGS_EXPECTED_COLUMNS);

  if (!meta.groups.some((g) => g.id === notitiesGroupId)) {
    throw new Error(
      `Instellingen-board ${boardId} heeft geen groep ${notitiesGroupId} (Notities) — ` +
        'zonder die groep kan een losse notitie niet van een instelling worden onderscheiden'
    );
  }

  const hasGroepen = meta.columns.some((c) => c.id === GROEPEN_COLUMN);
  const items = await client.fetchBoardItems<SettingsItem>(
    boardId,
    itemFields(hasGroepen),
    meta.items_count
  );

  const appRows: ConfigRowLike[] = [];
  const rateCents = new Map<string, number>();
  const seen = new Set<string>();
  let emptyGroupSelection = false;

  for (const item of items) {
    const name = item.name.trim();
    const isNote = item.group?.id === notitiesGroupId;

    if (isNote) {
      // A known key parked among the notes is a SILENT DELETE that leaves the row
      // visibly on the board. Everything else in this group is ignored — including a
      // brand-new item that has no category yet, which is the state every note passes
      // through in the seconds after it is created.
      if (isKnownName(name)) {
        throw new Error(
          `Instelling "${name}" staat in de Notities-groep — verplaats hem terug; ` +
            'zo verdwijnt een instelling zonder dat iemand het ziet'
        );
      }
      continue;
    }

    if (normaliseName(name) === TRAINERGROEPEN) {
      if (seen.has(GROUPS_KEY)) {
        throw new Error(duplicateMessage(name));
      }
      seen.add(GROUPS_KEY);

      /**
       * Filling in `Waarde` instead of `Groepen` must not be quietly ignored.
       *
       * Without this the typed-in value is dropped, the selection reads as empty, and
       * the environment answers instead — so someone who edited the board sees their
       * change have no effect at all, with nothing anywhere saying why.
       */
      if (valueOf(item).trim() !== '') {
        throw new Error(
          `Vul "${name}" in via de kolom Groepen, niet via Waarde — ` +
            'wat in Waarde staat wordt niet gebruikt; maak dat veld leeg'
        );
      }

      const values = cellOf(item, GROEPEN_COLUMN)?.values ?? [];
      if (values.length === 0) {
        // Row present, nothing chosen. Left OUT of the rows so the existing absent-key
        // fallback applies unchanged, with the distinction carried separately so the
        // error can name the right fix.
        emptyGroupSelection = true;
        continue;
      }

      const groups = await resolveGroepen(client, boardId, groepenOptions, values);
      appRows.push({ key: GROUPS_KEY, value: groups.join(',') });
      continue;
    }

    const resolved = resolveSetting(name, valueOf(item));
    if (resolved.kind === 'unknown') {
      throw new Error(
        `Onbekende rij "${name}" op het Instellingen-board — ` +
          'zet hem in de Notities-groep als het een notitie is, of corrigeer de naam'
      );
    }

    const dedupeKey = resolved.kind === 'app' ? resolved.row.key : `rate:${resolved.rateKey}`;
    if (seen.has(dedupeKey)) {
      throw new Error(duplicateMessage(name));
    }
    seen.add(dedupeKey);

    if (resolved.kind === 'app') {
      appRows.push(resolved.row);
    } else {
      rateCents.set(resolved.rateKey, resolved.hourlyRateCents);
    }
  }

  return { appRows, rateCents, emptyGroupSelection };
}
