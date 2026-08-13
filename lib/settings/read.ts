import { assertColumns } from '@lib/monday/schema-check';

import { isKnownName, resolveSetting } from './keys';

import type { ConfigRowLike } from '@lib/config';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { ExpectedColumn } from '@lib/monday/board-config';

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

/**
 * `updated_at` is NOT optional decoration.
 *
 * `fetchBoardItems` derives its *after* coherence inventory from these very items
 * rather than paginating a third time, so omitting `updated_at` makes every row compare
 * as changed and every read fail — a total outage caused by a tidied-up projection.
 *
 * `group { id }` is equally load-bearing: it is how a note is told from a setting, and
 * it has to be right from the instant an item is created.
 */
const ITEM_FIELDS = `id name updated_at group { id } column_values(ids: ["${VALUE_COLUMN}"]) { id text }`;

interface SettingsItem {
  id: string;
  name: string;
  updated_at?: string | null;
  group?: { id: string } | null;
  column_values?: Array<{ id: string; text?: string | null }> | null;
}

export interface SettingsBoardConfig {
  boardId: string;
  /**
   * Generated per board, so it travels WITH the board id rather than being a single
   * pinned production value — the preview board has a different one.
   */
  notitiesGroupId: string;
}

export interface RawSettings {
  appRows: ConfigRowLike[];
  /** rateKey → hourly rate in cents. Turned into cards by `rates.ts`. */
  rateCents: Map<string, number>;
}

function valueOf(item: SettingsItem): string {
  const cell = (item.column_values ?? []).find((c) => c.id === VALUE_COLUMN);
  return cell?.text ?? '';
}

export async function readSettings(
  client: MondayGraphQLClient,
  { boardId, notitiesGroupId }: SettingsBoardConfig
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

  const items = await client.fetchBoardItems<SettingsItem>(boardId, ITEM_FIELDS, meta.items_count);

  const appRows: ConfigRowLike[] = [];
  const rateCents = new Map<string, number>();
  const seen = new Set<string>();

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

    const resolved = resolveSetting(name, valueOf(item));
    if (resolved.kind === 'unknown') {
      throw new Error(
        `Onbekende rij "${name}" op het Instellingen-board — ` +
          'zet hem in de Notities-groep als het een notitie is, of corrigeer de naam'
      );
    }

    const dedupeKey = resolved.kind === 'app' ? resolved.row.key : `rate:${resolved.rateKey}`;
    if (seen.has(dedupeKey)) {
      throw new Error(
        `"${name}" staat meerdere keren op het Instellingen-board — ` +
          'twee rijen die elkaar tegenspreken is erger dan geen rij'
      );
    }
    seen.add(dedupeKey);

    if (resolved.kind === 'app') {
      appRows.push(resolved.row);
    } else {
      rateCents.set(resolved.rateKey, resolved.hourlyRateCents);
    }
  }

  return { appRows, rateCents };
}
