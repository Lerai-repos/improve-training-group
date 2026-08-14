import { describe, expect, it } from 'vitest';

import { INSTELLINGEN_PRODUCTION } from '../board';
import {
  activeOptionIds,
  assertCompleteOptionMap,
  deriveOptionMap,
  groepenOptions,
  parseOptionMap,
  priceableGroups,
  selectedGroupIds,
} from '../groepen';

import type { DropdownLabel, DropdownSelection } from '../groepen';

/**
 * The two live priceable groups, as Monday returns them once the column exists.
 *
 * `id` is deliberately a NUMBER here and a STRING in the selections below, because that
 * is exactly what the two typed APIs do: `settings.labels[].id` is an `Int`, while
 * `DropdownValue.values[].id` is a GraphQL `ID`. A test that used one shape in both
 * places would pass whatever the implementation happened to do.
 */
const LABELS: DropdownLabel[] = [
  { id: 1, label: 'Topics — topics' },
  { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
];

const selection = (...ids: Array<string | number>): DropdownSelection[] =>
  ids.map((id) => ({ id, label: 'irrelevant — the label is never parsed here' }));

const titles = new Map([
  ['topics', 'Topics'],
  ['nieuwe_groep__1', 'Nieuwe groep'],
]);

describe('priceableGroups', () => {
  /**
   * "Priceable" is `rateKey !== null`, not "a GROUP_POLICY key". Both live entries have
   * a rate today, so this pins the RULE rather than the current data — a future mapped
   * but unpriceable entry must not become selectable.
   */
  it('is exactly the groups that resolve to a rate', () => {
    expect(priceableGroups({ topics: { rateKey: '2020-2024', recommendable: true } })).toEqual([
      'topics',
    ]);
  });

  it('excludes a mapped group with no rate key', () => {
    const policy = {
      topics: { rateKey: '2020-2024', recommendable: true },
      acteurs: { rateKey: null, recommendable: true },
    };

    expect(priceableGroups(policy)).toEqual(['topics']);
  });

  it('reads the live policy when none is passed', () => {
    expect(priceableGroups()).toEqual(['topics', 'nieuwe_groep__1']);
  });
});

describe('groepenOptions', () => {
  it('labels each priceable group with its id embedded', () => {
    expect(groepenOptions(titles)).toEqual([
      { label: 'Topics — topics' },
      { label: 'Nieuwe groep — nieuwe_groep__1' },
    ]);
  });

  /**
   * A missing title means the group is gone from the Trainers board — so an option for it
   * would be selectable and could never produce a single trainer. That is precisely the
   * plausible GEEN MATCH the priceable-only rule exists to prevent, so it is refused
   * rather than labelled with the bare id.
   */
  it('refuses to build an option for a group that is not on the trainers board', () => {
    expect(() => groepenOptions(new Map([['topics', 'Topics']]))).toThrow(/nieuwe_groep__1/);
  });

  /**
   * The same guard covers the worse case: the Trainers board could not be read at all, so
   * EVERY label would be a guess. Silently writing those to the board is not recoverable
   * by looking at it afterwards — the labels would look deliberate.
   */
  it('refuses when the trainers board yielded no titles at all', () => {
    expect(() => groepenOptions(new Map())).toThrow();
  });

  it('refuses a title that is present but blank', () => {
    expect(() => groepenOptions(new Map([...titles, ['topics', '  ']]))).toThrow(/topics/);
  });

  it('never offers a group outside the priceable set', () => {
    const labels = groepenOptions(new Map([...titles, ['acteurs', 'Acteurs']])).map((o) => o.label);

    expect(labels.join(' ')).not.toContain('acteurs');
  });
});

describe('deriveOptionMap', () => {
  it('maps each option id to its group, keyed as a string', () => {
    expect(deriveOptionMap(LABELS)).toEqual(
      new Map([
        ['1', 'topics'],
        ['2', 'nieuwe_groep__1'],
      ])
    );
  });

  /**
   * A group title may legitimately contain the separator, so the id is the tail after
   * the LAST one — taking the first would yield a group id nobody configured.
   */
  it('takes the suffix after the last separator', () => {
    const map = deriveOptionMap([{ id: 7, label: 'Topics — extern — topics' }, LABELS[1]]);

    expect(map.get('7')).toBe('topics');
  });

  /**
   * The silent eligibility swap: everyone with board access can edit a label, and
   * pointing two of them at the same group would change who is recommended without a
   * single value on the board looking wrong.
   */
  it('refuses two options claiming the same group', () => {
    const duplicated: DropdownLabel[] = [
      { id: 1, label: 'Topics — topics' },
      { id: 2, label: 'Nieuwe groep — topics' },
    ];

    expect(() => deriveOptionMap(duplicated)).toThrow(/topics/);
  });

  it('refuses a suffix that is not a priceable group', () => {
    expect(() => deriveOptionMap([{ id: 1, label: 'Acteurs — acteurs' }])).toThrow(/acteurs/);
  });

  it('refuses a label with no separator at all', () => {
    expect(() => deriveOptionMap([{ id: 1, label: 'Topics' }])).toThrow(/Topics/);
  });

  it('refuses when a priceable group has no option', () => {
    expect(() => deriveOptionMap([LABELS[0]])).toThrow(/nieuwe_groep__1/);
  });

  /**
   * `is_deactivated` is how Monday retires a label. A retired EXTRA is ordinary
   * housekeeping; a retired EXPECTED one means the configured cohort can no longer be
   * selected at all, which is a broken board rather than a tidy one.
   */
  it('ignores a deactivated extra option', () => {
    const withRetired = [...LABELS, { id: 9, label: 'Oud — verlopen', is_deactivated: true }];

    expect(deriveOptionMap(withRetired).size).toBe(2);
  });

  it('refuses an ACTIVE extra option', () => {
    const withStranger = [...LABELS, { id: 9, label: 'Acteurs — acteurs' }];

    expect(() => deriveOptionMap(withStranger)).toThrow(/acteurs/);
  });

  it('refuses when an expected group exists only as a deactivated label', () => {
    const retiredExpected: DropdownLabel[] = [
      LABELS[0],
      { id: 2, label: 'Nieuwe groep — nieuwe_groep__1', is_deactivated: true },
    ];

    expect(() => deriveOptionMap(retiredExpected)).toThrow(/nieuwe_groep__1/);
  });
});

describe('activeOptionIds', () => {
  it('is the active labels, keyed as strings', () => {
    const ids = activeOptionIds([...LABELS, { id: 9, label: 'Oud — x', is_deactivated: true }]);

    expect(ids).toEqual(new Set(['1', '2']));
  });
});

describe('selectedGroupIds', () => {
  const map = new Map([
    ['1', 'topics'],
    ['2', 'nieuwe_groep__1'],
  ]);
  const active = new Set(['1', '2']);

  /**
   * The shape mismatch that no single-shaped mock would catch: the map is built from
   * NUMERIC settings ids and the selection arrives with STRING ids. Keyed on numbers,
   * every lookup would miss and the board would read as "nothing selected" — an empty
   * eligibility set that falls back to env before the cutover and FOUTs after it.
   */
  it('resolves string selection ids against a map built from numeric label ids', () => {
    const fromNumbers = deriveOptionMap(LABELS);

    expect(selectedGroupIds(selection('1', '2'), fromNumbers, active)).toEqual([
      'topics',
      'nieuwe_groep__1',
    ]);
  });

  it('resolves a numeric selection id too', () => {
    expect(selectedGroupIds(selection(1), map, active)).toEqual(['topics']);
  });

  /**
   * Identity is the option id. The label is display only, so renaming it — even to
   * something carrying a different group id — must change nothing.
   */
  it('never parses the label', () => {
    const renamed = [{ id: '1', label: 'Vaste pool — nieuwe_groep__1' }];

    expect(selectedGroupIds(renamed, map, active)).toEqual(['topics']);
  });

  it('throws on an option id the map does not know', () => {
    expect(() => selectedGroupIds(selection('99'), map, active)).toThrow(/99/);
  });

  /**
   * A selection SURVIVES its label being deactivated — the item still holds the id.
   * Dropping it silently would narrow who can be recommended with nothing to see, so
   * this is the one case that has to reach the engine as a failure.
   *
   * Written against a map that still contains the id, which is what a PINNED map looks
   * like: it cannot tell active from retired, so the check only works if activeness is
   * read live.
   */
  it('throws when a selected option has been deactivated', () => {
    expect(() => selectedGroupIds(selection('2'), map, new Set(['1']))).toThrow(
      /nieuwe_groep__1|gedeactiveerd/
    );
  });

  it('is empty for an empty selection rather than throwing', () => {
    expect(selectedGroupIds([], map, active)).toEqual([]);
  });

  /**
   * A PINNED map never passes through `deriveOptionMap`, so its entries are otherwise
   * unchecked — a mistyped constant would put a rate-less group into the selection,
   * where every trainer is dropped as `no_rate` and the run looks like a real GEEN MATCH.
   */
  it('rejects a mapped group that has no rate, even from a pinned map', () => {
    const bad = new Map([['1', 'acteurs']]);

    expect(() => selectedGroupIds(selection('1'), bad, new Set(['1']))).toThrow(/acteurs/);
  });
});

describe('parseOptionMap', () => {
  it('reads the configured form into canonical string keys', () => {
    expect(parseOptionMap('1=topics, 2=nieuwe_groep__1')).toEqual(
      new Map([
        ['1', 'topics'],
        ['2', 'nieuwe_groep__1'],
      ])
    );
  });

  /**
   * Validated WHOLE and up front rather than entry by entry when a selection happens to
   * use it: two ids pointing at one group is the silent eligibility swap, and noticing
   * it only when somebody selects the second one is far too late.
   */
  it('refuses two ids claiming the same group', () => {
    expect(() => parseOptionMap('1=topics,2=topics')).toThrow(/topics/);
  });

  it('refuses a repeated option id', () => {
    expect(() => parseOptionMap('1=topics,1=nieuwe_groep__1')).toThrow(/1/);
  });

  it('refuses a group with no rate', () => {
    expect(() => parseOptionMap('1=acteurs')).toThrow(/acteurs/);
  });

  it('refuses a malformed or empty list rather than yielding an empty map', () => {
    expect(() => parseOptionMap('topics')).toThrow();
    expect(() => parseOptionMap('1=')).toThrow();
    expect(() => parseOptionMap('  ')).toThrow();
  });

  /**
   * A PARTIAL map is the dangerous shape, because it works until it doesn't: with
   * `1=topics` pinned and `topics` selected, reads succeed and preflight agrees. The day
   * somebody picks the second, entirely legitimate dropdown option, every run fails on an
   * unknown option id — long after whoever configured it has moved on.
   */
  it('refuses a map that covers only some of the priceable groups', () => {
    expect(() => parseOptionMap('1=topics')).toThrow(/nieuwe_groep__1/);
  });
});

describe('assertCompleteOptionMap', () => {
  it('accepts a map covering every priceable group', () => {
    expect(() =>
      assertCompleteOptionMap(
        new Map([
          ['1', 'topics'],
          ['2', 'nieuwe_groep__1'],
        ])
      )
    ).not.toThrow();
  });

  it('names what is missing', () => {
    expect(() => assertCompleteOptionMap(new Map([['1', 'topics']]))).toThrow(/nieuwe_groep__1/);
  });

  /**
   * The pinned production constant goes through the same rule as a configured one. It is
   * absent until the migration runs, and a partial paste is exactly the mistake that
   * hand-copying option ids invites.
   */
  it('holds for the pinned production map once it is filled in', () => {
    const { groepenOptions: pinned } = INSTELLINGEN_PRODUCTION;
    if (pinned === undefined) {
      expect(pinned).toBeUndefined();
      return;
    }
    expect(() => assertCompleteOptionMap(pinned)).not.toThrow();
  });
});
