import { GROUP_POLICY } from '@lib/monday/board-config';

import type { GroupPolicy } from '@lib/monday/board-config';

/**
 * The `Groepen` dropdown — which trainer groups may be recommended from.
 *
 * This is the one setting that decides *who is eligible at all*, on a board everyone at
 * ITG can edit. So the rule this module exists to enforce is narrow and absolute:
 *
 *   **identity is the option id, never the label text.**
 *
 * Monday assigns each dropdown label a numeric id at creation and keeps it stable across
 * renames. If the group were read out of the label instead, editing `Topics — topics` to
 * `Topics — nieuwe_groep__1` would silently change who gets recommended, with no value on
 * the board looking wrong. The ` — <<group id>>` suffix is therefore DISPLAY, checked for
 * drift, and never trusted as identity once the map is pinned.
 */

/** How the id is separated from the human half of a label. */
const SEPARATOR = ' — ';

/** One label as the typed `settings.labels` returns it: `id` is an `Int`. */
export interface DropdownLabel {
  id: number | string;
  label: string;
  is_deactivated?: boolean | null;
}

/** One SELECTED option as `DropdownValue.values` returns it: `id` is an `ID` — a string. */
export interface DropdownSelection {
  id: number | string;
  label?: string | null;
}

/** What `create_dropdown_column` accepts: the label text, nothing else. */
export interface DropdownOptionInput {
  label: string;
}

/**
 * Option ids are canonical STRINGS, everywhere.
 *
 * The two typed APIs disagree on the JavaScript shape of the same identifier —
 * `settings.labels[].id` is an `Int`, `DropdownValue.values[].id` is an `ID` and arrives
 * as `"1"`. A map keyed on numbers therefore misses every selection, which reads as
 * "nothing selected": an empty eligibility set rather than an error. One `String()` at
 * every entry point is what keeps that from being possible.
 */
const key = (id: number | string): string => String(id);

const isActive = (label: DropdownLabel): boolean => label.is_deactivated !== true;

/**
 * The groups an option may point at: those that resolve to a RATE.
 *
 * Not "the keys of `GROUP_POLICY`" — `rateKey` is nullable, and a mapped but unpriceable
 * group would then be selectable while every trainer in it is excluded as `no_rate`.
 * That is the worst shape of failure available here: a real group, deliberately chosen,
 * producing a plausible GEEN MATCH.
 */
export function priceableGroups(policy: Record<string, GroupPolicy> = GROUP_POLICY): string[] {
  return Object.keys(policy).filter((id) => policy[id].rateKey !== null);
}

/**
 * Every priceable group still exists on the live Trainers board.
 *
 * A missing title is FATAL, not something to paper over with the bare id. Its absence
 * means one of two things and both disqualify: the group has been deleted, so an option
 * pointing at it is selectable and can never yield a single trainer — the plausible GEEN
 * MATCH this whole restriction exists to prevent — or the Trainers board could not be
 * read at all, in which case every label would be built from a guess.
 *
 * Its own function because the danger is NOT confined to creating the column. A run that
 * finds the dropdown already there (a resume, or a second invocation) goes straight to
 * creating the row, and `deriveOptionMap` cannot help: it checks labels against
 * `GROUP_POLICY`, which is code, so a label for a group deleted from Monday passes
 * happily. So this is asserted once at the entry to provisioning, on every path.
 */
export function assertLiveGroups(titles: ReadonlyMap<string, string>): void {
  const unknown = priceableGroups().filter((id) => (titles.get(id) ?? '').trim() === '');
  if (unknown.length > 0) {
    throw new Error(
      `Groep(en) ${unknown.join(', ')} staan niet op het trainersbord — ` +
        'een optie daarvoor zou te kiezen zijn en nooit iemand opleveren. ' +
        'Controleer het trainersbord (of of het gelezen kon worden) voordat je dit aanmaakt.'
    );
  }
}

/** The labels to create, one per priceable group, with the group id embedded. */
export function groepenOptions(titles: ReadonlyMap<string, string>): DropdownOptionInput[] {
  assertLiveGroups(titles);
  return priceableGroups().map((id) => ({ label: `${titles.get(id) ?? id}${SEPARATOR}${id}` }));
}

/** The active option ids, for validating a selection against what is still selectable. */
export function activeOptionIds(labels: readonly DropdownLabel[]): Set<string> {
  return new Set(labels.filter(isActive).map((l) => key(l.id)));
}

/**
 * Option id → group id, read from the labels themselves.
 *
 * Deploy ③'s identity source (nothing is pinned yet) and, after ④, the drift check that
 * catches a label whose suffix no longer agrees with the pinned map. Every way the set
 * can be wrong is a refusal, because each one changes who is eligible:
 *
 * | duplicate group        | two options, one meaning — the silent swap        |
 * | unknown / unpriceable  | a choice that can only produce GEEN MATCH         |
 * | missing priceable      | a configured cohort nobody can select              |
 * | extra ACTIVE label     | a selectable option we never offered               |
 * | extra DEACTIVATED      | fine — that is how Monday retires an option        |
 */
export function deriveOptionMap(labels: readonly DropdownLabel[]): Map<string, string> {
  const expected = new Set(priceableGroups());
  const map = new Map<string, string>();
  const claimedBy = new Map<string, string>();

  for (const label of labels) {
    // Retired options are ignored entirely: they are not selectable, so they cannot
    // change an answer, and refusing them would make ordinary housekeeping fatal.
    if (!isActive(label)) {
      continue;
    }

    const cut = label.label.lastIndexOf(SEPARATOR);
    if (cut === -1) {
      throw new Error(
        `Optie "${label.label}" in de kolom Groepen mist het groep-id achter "${SEPARATOR.trim()}" — ` +
          'hernoem hem terug of draai de instellingen-groepen-opdracht opnieuw'
      );
    }

    const groupId = label.label.slice(cut + SEPARATOR.length).trim();
    if (!expected.has(groupId)) {
      throw new Error(
        `Optie "${label.label}" wijst naar groep "${groupId}", die geen tarief heeft — ` +
          'trainers uit die groep kunnen nooit worden aanbevolen'
      );
    }

    const other = claimedBy.get(groupId);
    if (other !== undefined) {
      throw new Error(
        `De opties "${other}" en "${label.label}" wijzen allebei naar groep "${groupId}" — ` +
          'daardoor verandert ongemerkt wie er aanbevolen kan worden'
      );
    }
    claimedBy.set(groupId, label.label);
    map.set(key(label.id), groupId);
  }

  const missing = [...expected].filter((id) => !claimedBy.has(id));
  if (missing.length > 0) {
    throw new Error(
      `De kolom Groepen mist een (actieve) optie voor: ${missing.join(', ')} — ` +
        'die groep is dan niet meer te kiezen'
    );
  }

  return map;
}

/**
 * Option map from its configured form, `1=topics,2=nieuwe_groep__1`.
 *
 * Validated whole and up front, rather than one entry at a time when a selection happens
 * to use it: a map with two ids pointing at the same group is the silent eligibility
 * swap, and finding that out only when somebody selects the second one is too late.
 */
/**
 * Every priceable group is mapped exactly once — no more, and crucially no FEWER.
 *
 * A partial map is the dangerous shape, because it works right up until it doesn't: with
 * `1=topics` pinned and `topics` currently selected, everything reads fine and preflight
 * agrees. The day someone picks the second, entirely legitimate dropdown option, the
 * engine calls it an unknown option and every run fails.
 */
export function assertCompleteOptionMap(map: ReadonlyMap<string, string>): void {
  const mapped = new Set(map.values());
  const missing = priceableGroups().filter((id) => !mapped.has(id));
  if (missing.length > 0) {
    throw new Error(
      `De vastgelegde optielijst mist groep(en): ${missing.join(', ')} — ` +
        'die zijn wel in de dropdown te kiezen, en dan faalt elke berekening'
    );
  }
}

export function parseOptionMap(raw: string): Map<string, string> {
  const priceable = new Set(priceableGroups());
  const map = new Map<string, string>();
  const groups = new Set<string>();

  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') {
      continue;
    }
    const at = entry.indexOf('=');
    const id = at === -1 ? '' : entry.slice(0, at).trim();
    const groupId = at === -1 ? '' : entry.slice(at + 1).trim();
    if (id === '' || groupId === '') {
      throw new Error(`Ongeldige optie "${entry}" — verwacht de vorm 1=topics,2=nieuwe_groep__1`);
    }
    if (!priceable.has(groupId)) {
      throw new Error(`Optie "${entry}" wijst naar groep "${groupId}", die geen tarief heeft`);
    }
    if (map.has(id)) {
      throw new Error(`Optie-id ${id} staat twee keer in de optielijst`);
    }
    if (groups.has(groupId)) {
      throw new Error(`Groep "${groupId}" staat twee keer in de optielijst`);
    }
    map.set(id, groupId);
    groups.add(groupId);
  }

  if (map.size === 0) {
    throw new Error('De optielijst is leeg — verwacht de vorm 1=topics,2=nieuwe_groep__1');
  }
  assertCompleteOptionMap(map);
  return map;
}

/**
 * The selected option ids → group ids.
 *
 * `activeIds` is a PARAMETER, not something the map implies. After the cutover the map is
 * a code constant, so it still contains an option id long after someone deactivates that
 * label — and a static map cannot tell retired from live. Without a freshly read active
 * set, the engine would go on recommending a group that nobody can see is selected.
 */
export function selectedGroupIds(
  values: readonly DropdownSelection[],
  map: ReadonlyMap<string, string>,
  activeIds: ReadonlySet<string>
): string[] {
  return values.map((value) => {
    const id = key(value.id);
    const groupId = map.get(id);
    if (groupId === undefined) {
      throw new Error(
        `Onbekende optie ${id} geselecteerd in de kolom Groepen — ` +
          'de optielijst is aangepast; draai de instellingen-groepen-opdracht opnieuw'
      );
    }
    // Checked again at the point of USE, because a pinned map bypasses `deriveOptionMap`
    // entirely: a mistyped constant or override would otherwise put an unpriceable group
    // into the selection, where every trainer in it is dropped as `no_rate` and the whole
    // thing reads as a legitimate GEEN MATCH.
    if (!priceableGroups().includes(groupId)) {
      throw new Error(
        `Optie ${id} wijst naar groep "${groupId}", die geen tarief heeft — ` +
          'controleer de vastgelegde optielijst'
      );
    }
    if (!activeIds.has(id)) {
      throw new Error(
        `Groep "${groupId}" is geselecteerd maar de bijbehorende optie is gedeactiveerd — ` +
          'activeer hem weer of kies een andere groep'
      );
    }
    return groupId;
  });
}
