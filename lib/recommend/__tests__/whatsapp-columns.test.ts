import { describe, expect, it } from 'vitest';

import { whatsappColumnsFor, type WhatsappColumn } from '@lib/monday/board-config';

import { checkWhatsappColumns, toTrainingDetails, type ObservedColumn } from '../whatsapp';

/**
 * Drift on these columns degrades the message; it does not fail the request. The rule
 * that matters is the second half of that sentence: **a diagnosed field is suppressed.**
 *
 * A warning beside a message that still prints the wrong klant is worse than no check —
 * the planner reads the message, not the warning, and sends a training to the wrong
 * company's trainers. So every test here asserts on the rendered text, not only on the
 * diagnostic list.
 */

const SPECS = whatsappColumnsFor('5087396949');
const spec = (field: string): WhatsappColumn => {
  const found = SPECS.find((column) => column.field === field);
  if (found === undefined) {
    throw new Error(`no spec for ${field}`);
  }
  return found;
};

/** A healthy board: every configured column, right type, right settings. */
function healthyBoard(): Map<string, ObservedColumn> {
  return new Map(
    SPECS.map((column) => [
      column.id,
      { type: column.type, settingsStr: (column.settingsIncludes ?? []).join(' ') },
    ])
  );
}

const allPresent = (): Set<string> => new Set(SPECS.map((column) => column.id));

function values(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      [spec('datum').id]: '2026-03-23',
      [spec('thema').id]: 'Effectief time management',
      [spec('themaRelation').id]: 'Time management',
      [spec('tijden').id]: '09.00-13.00',
      [spec('taal').id]: 'ENG',
      [spec('locatie').id]: 'Naritaweg 51, 1043 BP Amsterdam',
      [spec('deelnemers').id]: '9',
      [spec('trainers').id]: '2',
      [spec('acteurs').id]: '1',
      [spec('klant').id]: 'Rabobank',
      ...overrides,
    })
  );
}

describe('checkWhatsappColumns', () => {
  it('says nothing about a healthy board', () => {
    expect(checkWhatsappColumns(allPresent(), healthyBoard(), SPECS)).toEqual([]);
  });

  /** Monday omits ids it does not recognise — an absence that must not read as an empty field. */
  it('reports a column missing from the response', () => {
    const present = allPresent();
    present.delete(spec('tijden').id);

    expect(checkWhatsappColumns(present, healthyBoard(), SPECS)).toEqual([
      { field: 'tijden', columnId: spec('tijden').id, reason: 'missing' },
    ]);
  });

  it('reports a retyped column', () => {
    const board = healthyBoard();
    board.set(spec('deelnemers').id, { type: 'numbers', settingsStr: null });

    expect(checkWhatsappColumns(allPresent(), board, SPECS)).toEqual([
      { field: 'deelnemers', columnId: spec('deelnemers').id, reason: 'type' },
    ]);
  });

  /** The one type-checking alone cannot see. */
  it('reports a re-sourced mirror whose type never changed', () => {
    const board = healthyBoard();
    board.set(spec('klant').id, { type: 'mirror', settingsStr: '{"boardIds":[999]}' });

    expect(checkWhatsappColumns(allPresent(), board, SPECS)).toEqual([
      { field: 'klant', columnId: spec('klant').id, reason: 'settings' },
    ]);
  });

  it('reports a relation repointed at another board', () => {
    const board = healthyBoard();
    board.set(spec('themaRelation').id, { type: 'board_relation', settingsStr: '{"boardIds":[42]}' });

    expect(checkWhatsappColumns(allPresent(), board, SPECS)).toEqual([
      { field: 'themaRelation', columnId: spec('themaRelation').id, reason: 'settings' },
    ]);
  });

  it('ignores whitespace when matching the settings signature', () => {
    const board = healthyBoard();
    board.set(spec('themaRelation').id, {
      type: 'board_relation',
      settingsStr: '{ "boardIds" : [ 5067928440 ] }',
    });

    expect(checkWhatsappColumns(allPresent(), board, SPECS)).toEqual([]);
  });

  /** Acteuraantal is genuinely absent on Agenda 2024. That is config, not drift. */
  it('does not report a column declared optional on this board', () => {
    const specs = whatsappColumnsFor('1311331281');
    const present = new Set(specs.map((column) => column.id));
    const board = new Map(
      specs.map((column) => [
        column.id,
        { type: column.type, settingsStr: (column.settingsIncludes ?? []).join(' ') },
      ])
    );

    expect(specs.some((column) => column.field === 'acteurs')).toBe(false);
    expect(checkWhatsappColumns(present, board, specs)).toEqual([]);
  });
});

describe('toTrainingDetails', () => {
  it('reads the message fields off the columns', () => {
    const details = toTrainingDetails(values(), { itemName: 'Rabobank', city: null, specs: SPECS });

    expect(details).toMatchObject({
      datum: '2026-03-23',
      thema: 'Effectief time management',
      tijden: '09.00-13.00',
      taal: 'ENG',
      deelnemers: '9',
      trainers: 2,
      acteurs: 1,
      klant: 'Rabobank',
    });
  });

  it('prefers the resolved city over the raw location', () => {
    const details = toTrainingDetails(values(), {
      itemName: 'Rabobank',
      city: 'Amsterdam',
      specs: SPECS,
    });
    expect(details.locatie).toBe('Amsterdam');
  });

  it('falls back to the raw location when there is no city', () => {
    const details = toTrainingDetails(values(), { itemName: 'Rabobank', city: null, specs: SPECS });
    expect(details.locatie).toBe('Naritaweg 51, 1043 BP Amsterdam');
  });

  it('falls back to the theme relation when the free text is empty', () => {
    const details = toTrainingDetails(values({ [spec('thema').id]: '' }), {
      itemName: 'Rabobank',
      city: null,
      specs: SPECS,
    });
    expect(details.thema).toBe('Time management');
  });

  it('falls back to the item name when the Bedrijf mirror is empty', () => {
    const details = toTrainingDetails(values({ [spec('klant').id]: '' }), {
      itemName: 'KNGF Geleidehonden',
      city: null,
      specs: SPECS,
    });
    expect(details.klant).toBe('KNGF Geleidehonden');
  });

  it('treats a non-numeric count as absent rather than zero', () => {
    const details = toTrainingDetails(values({ [spec('trainers').id]: 'twee' }), {
      itemName: 'Rabobank',
      city: null,
      specs: SPECS,
    });
    expect(details.trainers).toBeNull();
  });

  /**
   * The point of the whole diagnostics apparatus: a drifted column contributes NOTHING.
   * Warning and printing anyway is the failure mode this is built to prevent.
   */
  it('never prints the value of a drifted column', () => {
    const details = toTrainingDetails(values({ [spec('klant').id]: 'De verkeerde klant BV' }), {
      itemName: 'ABN AMRO',
      city: null,
      specs: SPECS,
      diagnostics: [{ field: 'klant', columnId: spec('klant').id, reason: 'settings' }],
    });

    // Falling back to the item name is right — that source did not drift. What must never
    // happen is the re-sourced mirror's own value reaching the message.
    expect(details.klant).toBe('ABN AMRO');
  });

  it('leaves the field empty when the drifted column has no untainted fallback', () => {
    const details = toTrainingDetails(values(), {
      itemName: null,
      city: null,
      specs: SPECS,
      diagnostics: [{ field: 'klant', columnId: spec('klant').id, reason: 'settings' }],
    });

    expect(details.klant).toBeNull();
  });

  /** Suppressing the relation must not silently promote it over the free text either. */
  it('suppresses the theme fallback when the relation drifted', () => {
    const details = toTrainingDetails(values({ [spec('thema').id]: '' }), {
      itemName: 'Rabobank',
      city: null,
      specs: SPECS,
      diagnostics: [
        { field: 'themaRelation', columnId: spec('themaRelation').id, reason: 'settings' },
      ],
    });

    expect(details.thema).toBeNull();
  });
});
