import { assertColumns } from '@lib/monday/schema-check';

import { activeOptionIds, assertLiveGroups, deriveOptionMap, groepenOptions } from './groepen';
import { isKnownName, normaliseName } from './keys';
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

/**
 * The row goes in with the OTHER settings — no group of its own.
 *
 * An earlier version gave it a `Groepselectie` group so the otherwise-blank `Groepen`
 * column would read as deliberate. In practice it read as a second board: Monday renders
 * each group as its own titled block, and "groep" then meant three different things on
 * one screen (a Monday section, the `Groepen` column, a trainer group).
 *
 * Located by where the EXISTING settings live rather than by a group title, because
 * titles are editable and this must keep working after someone renames the section. Only
 * `Notities` is load-bearing to the reader; every other group is just a place to sit.
 */
async function settingsLayout(deps: ProvisionGroepenDeps): Promise<{
  settingsGroupId: string;
  groepenRow: { id: string; groupId: string } | null;
}> {
  const [meta] = await deps.read.getSchema([deps.boardId]);
  if (meta === undefined) {
    throw new Error(`Board ${deps.boardId} niet gevonden of niet toegankelijk`);
  }

  const items = await deps.read.fetchBoardItems<{
    id: string;
    name: string;
    updated_at?: string | null;
    group?: { id: string } | null;
  }>(deps.boardId, 'id name updated_at group { id }', meta.items_count);

  /**
   * The anchor must NOT be the groepen row itself.
   *
   * `TRAINERGROEPEN` is a known name too, so without this exclusion a board still in the
   * old layout — the row alone in its own `Groepselectie` group — answers "that group is
   * where the settings live", and everything lands right back where we are trying to
   * move it away from. Which of the two wins is decided by fetch order, so it is the
   * kind of bug that works until it doesn't.
   */
  const anchor = items.find(
    (i) =>
      isKnownName(i.name.trim()) &&
      normaliseName(i.name) !== ROW_NAME &&
      i.group?.id !== deps.notitiesGroupId
  );
  if (anchor?.group?.id === undefined) {
    throw new Error(
      `Geen bestaande instelling gevonden op board ${deps.boardId} om "${ROW_NAME}" bij te zetten`
    );
  }

  const row = items.find((i) => normaliseName(i.name) === ROW_NAME);
  return {
    settingsGroupId: anchor.group.id,
    groepenRow: row?.group?.id === undefined ? null : { id: row.id, groupId: row.group.id },
  };
}

/**
 * Put an already-existing row back with the others, if an earlier version stranded it.
 *
 * Unlike a selection, a group placement has no value to race over — moving is safe and
 * idempotent, so this is a repair rather than the overwrite the rest of this module
 * refuses. Without it, re-running against a board built by the `Groepselectie` version
 * reports success and changes nothing, which is the worst combination available.
 */
async function relocateIfStranded(
  deps: ProvisionGroepenDeps,
  row: { id: string; groupId: string },
  settingsGroupId: string,
  actions: string[]
): Promise<void> {
  if (row.groupId === settingsGroupId) {
    return;
  }
  actions.push(`"${ROW_NAME}" verplaatst naar de groep met de andere instellingen`);

  /**
   * The group it came from is REPORTED, never deleted.
   *
   * Deleting it is the tempting finish — Monday renders an empty group as its own titled
   * block, so the extra section survives the move. But `delete_group` takes every item in
   * the group with it and has no conditional form: between proving the group empty and
   * deleting it, a planner can drop a row in, and that row is gone. Checking first only
   * narrows the window, it does not close it.
   *
   * Doing it by hand is safe because a human can see the board is quiet. A command cannot,
   * and this module's whole rule is that it refuses where it cannot be sure. One click of
   * manual cleanup is a fair price for never destroying somebody's row.
   */
  const others = (await itemsIn(deps, row.groupId)).filter((i) => i.id !== row.id);
  actions.push(
    others.length === 0
      ? `groep ${row.groupId} is daarna leeg — verwijder hem met de hand`
      : `groep ${row.groupId} houdt nog ${others.length} rij(en): ${others
          .map((i) => i.name)
          .join(', ')}`
  );

  if (!deps.apply) {
    return;
  }
  await deps.write.mutate(
    `mutation ($i: ID!, $g: String!) { move_item_to_group(item_id: $i, group_id: $g) { id } }`,
    { i: row.id, g: settingsGroupId },
    { idempotencyKey: `${deps.keyPrefix}:move` }
  );
}

/** Who is still in a group, read fresh. */
async function itemsIn(
  deps: ProvisionGroepenDeps,
  groupId: string
): Promise<Array<{ id: string; name: string }>> {
  const [meta] = await deps.read.getSchema([deps.boardId]);
  const items = await deps.read.fetchBoardItems<{
    id: string;
    name: string;
    updated_at?: string | null;
    group?: { id: string } | null;
  }>(deps.boardId, 'id name updated_at group { id }', meta?.items_count ?? null);
  return items.filter((i) => i.group?.id === groupId).map((i) => ({ id: i.id, name: i.name }));
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
        `rij "${ROW_NAME}" = ${selection.join(', ')} (bij de andere instellingen)`
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

  const { settingsGroupId, groepenRow } = await settingsLayout(deps);
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
    // Right selection, possibly the wrong place — a board built by the `Groepselectie`
    // version. Left alone, a re-run would report success and change nothing.
    if (groepenRow !== null) {
      await relocateIfStranded(deps, groepenRow, settingsGroupId, actions);
    }
    log(
      actions.length > 0
        ? `klaar: ${actions.join(', ')}`
        : `rij "${ROW_NAME}" staat er al met de juiste selectie`
    );
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
        group: settingsGroupId,
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
