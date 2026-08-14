import { assertColumns } from '@lib/monday/schema-check';

import { activeOptionIds, assertLiveGroups, deriveOptionMap, groepenOptions } from './groepen';
import { fetchGroepenLabels, readSettings, GROEPEN_COLUMN, SETTINGS_EXPECTED_COLUMNS } from './read';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';
import type { DropdownLabel } from './groepen';

/**
 * Put the `Groepen` dropdown, its options and the `TRAINERGROEPEN` row on a settings
 * board — once, and safely on a board that is already in use.
 *
 * Shared by two callers with opposite starting points: `instellingen:groepen` migrates a
 * live seven-row board, `instellingen:create` builds a fresh one. Both need the same
 * invariants, and the fresh board needs the discovered option ids back immediately,
 * because Monday generates them and no constant can know them yet.
 *
 * ## Refuses, never repairs
 *
 * A dropdown SELECTION is an item value, and item values have no revision or CAS. So
 * "the row exists but is empty, let me fill it in" is a blind overwrite of whatever a
 * human was in the middle of choosing — and the read-back afterwards would only confirm
 * our own write. Every state that is not "absent" or "already exactly right" is reported
 * and left alone.
 *
 * The one write that IS safe is the bootstrap: the selection travels inside the same
 * `create_item` that creates the row, so the row is never visible in an empty state and
 * there is no window to race.
 */

const GROEPEN_TITLE = 'Groepen';
const GROEPSELECTIE_GROUP = 'Groepselectie';
const ROW_NAME = 'TRAINERGROEPEN';
const CATEGORIE = 'Trainergroepen';
const OMSCHRIJVING =
  'Uit welke trainergroepen aanbevelingen mogen komen. Kies minimaal één groep in de kolom ' +
  'Groepen — niet in Waarde.';

/**
 * The idempotency prefix, derived in ONE place so no caller can forget the board id.
 *
 * Monday remembers a key for 30 minutes and this command deliberately runs against
 * production and the isolated preview board both. An operation-only key would let the
 * preview's mutation replay the production response — reported as success, having done
 * nothing at all.
 */
export function groepenKeyPrefix(boardId: string): string {
  return `groepen:${boardId}`;
}

export interface ProvisionGroepenDeps {
  read: MondayGraphQLClient;
  write: MondayMutationClient;
  boardId: string;
  notitiesGroupId: string;
  /**
   * Seeds every `Idempotency-Key` and MUST identify the board.
   *
   * Monday remembers a key for 30 minutes, and this runs against production and the
   * isolated preview board both. An operation-only key would let the preview's mutation
   * replay the production response — reported as success, having done nothing.
   */
  keyPrefix: string;
  apply: boolean;
  /**
   * The board does not exist yet — a dry run of the command that would create it.
   *
   * Without this, `instellingen:create --dry-run` hands over the synthetic id its own
   * preview uses, the first schema query finds no such board, and the whole safe preview
   * dies at the last step. Not inferred from "board not found": on the MIGRATION command
   * a board that cannot be read is a typo'd id and must still be reported.
   */
  plannedBoard?: boolean;
  /** The groups to seed, already resolved by the caller to its own correct source. */
  selection: readonly string[];
  /** Trainers-board group titles, for the human half of each label. */
  titles: ReadonlyMap<string, string>;
  log?: (line: string) => void;
}

export interface ProvisionGroepenResult {
  /** Option id → group id, as Monday assigned them. Empty on a dry run. */
  optionMap: Map<string, string>;
  /** What actually changed, for the operator. */
  actions: string[];
}

/** The numeric label ids to select, in the order the options were defined. */
function optionIdsFor(selection: readonly string[], map: ReadonlyMap<string, string>): number[] {
  return selection.map((groupId) => {
    const entry = [...map.entries()].find(([, group]) => group === groupId);
    if (entry === undefined) {
      throw new Error(
        `Groep "${groupId}" heeft geen optie in de kolom Groepen — ` +
          'de optielijst en de gewenste selectie lopen uiteen'
      );
    }
    const id = Number(entry[0]);
    if (!Number.isInteger(id)) {
      throw new Error(`Optie-id "${entry[0]}" is geen geheel getal — dat kan Monday niet zijn`);
    }
    return id;
  });
}

async function ensureColumn(deps: ProvisionGroepenDeps, actions: string[]): Promise<boolean> {
  const [meta] = await deps.read.getSchema([deps.boardId]);
  if (meta === undefined) {
    throw new Error(`Board ${deps.boardId} niet gevonden of niet toegankelijk`);
  }

  // Proof this really is a settings board before anything is written to it. Cheap, and
  // the alternative is creating a stray dropdown on whatever board was passed by mistake.
  assertColumns(meta, SETTINGS_EXPECTED_COLUMNS);

  const existing = meta.columns.find((c) => c.id === GROEPEN_COLUMN);
  if (existing !== undefined) {
    if (existing.type !== 'dropdown') {
      throw new Error(
        `Kolom ${GROEPEN_COLUMN} bestaat maar is type '${existing.type}', verwacht 'dropdown'. ` +
          'Handmatig corrigeren; dit script overschrijft geen bestaande kolom.'
      );
    }
    return false;
  }

  const labels = groepenOptions(deps.titles);
  // The exact label texts, because this is the one thing a human should read before
  // applying: after this they are display only, and a typo in a suffix is a refusal.
  actions.push(
    `kolom ${GROEPEN_COLUMN} (dropdown) met opties: ${labels.map((l) => `"${l.label}"`).join(', ')}`
  );
  if (!deps.apply) {
    return true;
  }

  /**
   * The labels travel WITH the column.
   *
   * A dropdown created empty has to be filled by a second write against the column's
   * current revision — a read-modify-write with a real race. Created together there is
   * no window in which the column exists without its options, and nothing else has ever
   * touched it.
   */
  await deps.write.mutate(
    `mutation ($board: ID!, $id: String, $title: String!, $defaults: CreateDropdownColumnSettingsInput) {
       create_dropdown_column(board_id: $board, id: $id, title: $title, defaults: $defaults) { id }
     }`,
    {
      board: deps.boardId,
      id: GROEPEN_COLUMN,
      title: GROEPEN_TITLE,
      defaults: { labels: groepenOptions(deps.titles) },
    },
    { idempotencyKey: `${deps.keyPrefix}:column` }
  );
  return true;
}

async function ensureGroup(deps: ProvisionGroepenDeps, actions: string[]): Promise<string> {
  const [meta] = await deps.read.getSchema([deps.boardId]);
  const existing = meta?.groups.find((g) => g.title === GROEPSELECTIE_GROUP);
  if (existing !== undefined) {
    return existing.id;
  }

  actions.push(`groep "${GROEPSELECTIE_GROUP}"`);
  if (!deps.apply) {
    return `(dry-run:${GROEPSELECTIE_GROUP})`;
  }

  const result = await deps.write.mutate<{ create_group: { id: string } }>(
    'mutation ($board: ID!, $name: String!) { create_group(board_id: $board, group_name: $name) { id } }',
    { board: deps.boardId, name: GROEPSELECTIE_GROUP },
    { idempotencyKey: `${deps.keyPrefix}:group` }
  );
  return result.create_group.id;
}

/**
 * What the board currently says about the selection, read through the ENGINE's reader.
 *
 * Not a bespoke query: the contract being established is "the engine can read this
 * board", and anything the reader refuses — a duplicate row, a value typed into `Waarde`,
 * an incoherent option set — must stop the migration rather than be discovered later by
 * a training that ends in FOUT.
 */
async function currentSelection(
  deps: ProvisionGroepenDeps,
  optionMap: ReadonlyMap<string, string>
): Promise<{ state: 'absent' | 'empty' | 'set'; groups: string[] }> {
  const raw = await readSettings(deps.read, {
    boardId: deps.boardId,
    notitiesGroupId: deps.notitiesGroupId,
    groepenOptions: optionMap,
  });

  if (raw.emptyGroupSelection) {
    return { state: 'empty', groups: [] };
  }
  const row = raw.appRows.find((r) => r.key === 'RECOMMENDABLE_TRAINER_GROUPS');
  if (row === undefined) {
    return { state: 'absent', groups: [] };
  }
  return { state: 'set', groups: row.value.split(',').filter((g) => g !== '') };
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

export async function provisionGroepselectie(
  deps: ProvisionGroepenDeps
): Promise<ProvisionGroepenResult> {
  const log = deps.log ?? (() => {});
  const actions: string[] = [];

  /**
   * Deduplicated ONCE, at the door, and used for everything after.
   *
   * `RECOMMENDABLE_TRAINER_GROUPS=topics,topics` survives the env parser and the schema
   * intact, so the seed can genuinely arrive with repeats. Sent as `{ids:[1,1]}` Monday
   * stores one selection — and the post-write check, comparing lengths, then fails on a
   * row it has already created. Every later run sees "a different selection" and refuses,
   * which is a board nobody can migrate without hand-editing.
   */
  const selection = [...new Set(deps.selection)];

  if (selection.length === 0) {
    throw new Error(
      'Er is geen groep om vast te leggen — een lege selectie zou elke training op ' +
        'GEEN MATCH zetten'
    );
  }

  /**
   * Checked HERE, before any branch, not inside the create-the-column path.
   *
   * A run that finds the dropdown already present — a resume, or simply a second
   * invocation — would otherwise skip this entirely and go on to create the row for a
   * group that no longer exists on the Trainers board. `deriveOptionMap` is no help:
   * it validates labels against `GROUP_POLICY`, which is code, so a label left over from
   * an earlier run passes even after the group behind it is deleted from Monday.
   */
  assertLiveGroups(deps.titles);

  if (deps.plannedBoard && !deps.apply) {
    // Nothing to inspect: the board this would live on does not exist yet. Describing is
    // the whole value of a dry run here, and querying a synthetic id can only throw.
    const labels = groepenOptions(deps.titles).map((l) => `"${l.label}"`);
    log(
      `zou aanmaken: kolom ${GROEPEN_COLUMN} (dropdown) met opties ${labels.join(', ')}, ` +
        `groep "${GROEPSELECTIE_GROUP}", rij "${ROW_NAME}" = ${selection.join(', ')}`
    );
    return { optionMap: new Map(), actions };
  }

  const created = await ensureColumn({ ...deps, selection }, actions);
  if (created && !deps.apply) {
    // Nothing downstream can be inspected on a board where the column does not exist
    // yet, and guessing what Monday WOULD assign is exactly the invention this command
    // is built to avoid.
    log(`dry run: ${actions.join(', ')} — en daarna de rij "${ROW_NAME}"`);
    return { optionMap: new Map(), actions };
  }

  const labels: DropdownLabel[] = await fetchGroepenLabels(deps.read, deps.boardId);
  /**
   * The COMPLETE option set, checked here and not on the engine path.
   *
   * An item's selected values can never show that an unselected option has gone missing:
   * with one group selected, the read-back would be perfectly happy while the other
   * priceable group had been deleted from the dropdown and nobody could pick it.
   */
  const optionMap = deriveOptionMap(labels);
  const active = activeOptionIds(labels);
  const inactive = [...optionMap.keys()].filter((id) => !active.has(id));
  if (inactive.length > 0) {
    throw new Error(`Optie(s) ${inactive.join(', ')} zijn gedeactiveerd — activeer ze weer`);
  }

  const groupId = await ensureGroup(deps, actions);
  const current = await currentSelection(deps, optionMap);

  if (current.state === 'empty') {
    throw new Error(
      `De rij "${ROW_NAME}" bestaat al maar er is niets geselecteerd. Kies de groepen met de ` +
        'hand: dit script schrijft geen bestaande rij over, want een selectie heeft geen ' +
        'revisiecontrole en zou dan iemands keuze overschrijven.'
    );
  }

  if (current.state === 'set') {
    if (!same(current.groups, selection)) {
      throw new Error(
        `De rij "${ROW_NAME}" heeft al een andere selectie (${current.groups.join(', ')}) dan ` +
          `verwacht (${selection.join(', ')}). Dat is iemands keuze, geen gat om te vullen — ` +
          'controleer welke van de twee klopt en pas hem met de hand aan.'
      );
    }
    log(`rij "${ROW_NAME}" staat er al met de juiste selectie`);
    return { optionMap, actions };
  }

  actions.push(`rij "${ROW_NAME}" = ${selection.join(', ')}`);
  if (deps.apply) {
    await deps.write.mutate(
      `mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) { id }
       }`,
      {
        board: deps.boardId,
        group: groupId,
        name: ROW_NAME,
        // The selection travels WITH the create. This is the only write to an item value
        // in the whole feature, and it is safe precisely because the row does not exist
        // yet: there is no window in which anyone could see or change it.
        values: JSON.stringify({
          itg_omschrijving: OMSCHRIJVING,
          itg_categorie: { label: CATEGORIE },
          [GROEPEN_COLUMN]: { ids: optionIdsFor(selection, optionMap) },
        }),
      },
      { idempotencyKey: `${deps.keyPrefix}:item` }
    );

    const after = await currentSelection(deps, optionMap);
    if (after.state !== 'set' || !same(after.groups, selection)) {
      throw new Error(
        `Na het aanmaken leest "${ROW_NAME}" als ${after.state === 'set' ? after.groups.join(', ') : after.state} ` +
          `in plaats van ${selection.join(', ')}`
      );
    }
  }

  log(actions.length > 0 ? `klaar: ${actions.join(', ')}` : 'niets te doen');
  return { optionMap, actions };
}
