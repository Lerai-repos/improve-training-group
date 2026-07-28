import { describe, expect, it } from 'vitest';

import { THEMA_QUAL_COLOURS } from '@lib/monday/board-config';

import {
  parseThemeQualifications,
  parseTrainingRead,
  type TrainingColumns,
} from '../monday-reader';

const COLS: TrainingColumns = {
  themaRelation: 'rel',
  datum: 'date',
  duur: 'dur',
  locatie: 'loc',
};

function trainingResponse(
  columns: Array<{ id: string; text?: string; linked_item_ids?: number[] }>
) {
  return { items: [{ id: 'tr1', updated_at: '2026-07-01', column_values: columns }] };
}

function themeItem(id: string, greenTrainers: number[] = []) {
  // A BoardRelationValue always returns linked_item_ids (empty array when unlinked).
  return {
    id,
    column_values: [
      { id: THEMA_QUAL_COLOURS.groen, linked_item_ids: greenTrainers },
      { id: THEMA_QUAL_COLOURS.oranje, linked_item_ids: [] },
      { id: THEMA_QUAL_COLOURS.rood, linked_item_ids: [] },
      { id: THEMA_QUAL_COLOURS.grijs, linked_item_ids: [] },
    ],
  };
}

describe('parseThemeQualifications (fail-closed)', () => {
  it('returns observations for a complete response', () => {
    const obs = parseThemeQualifications({ items: [themeItem('th1', [1, 2])] }, ['th1']);
    expect(obs).toEqual([
      { trainerExternalId: '1', themaExternalId: 'th1', colour: 'groen' },
      { trainerExternalId: '2', themaExternalId: 'th1', colour: 'groen' },
    ]);
  });

  it('throws on a malformed response (never silently empty → GEEN MATCH)', () => {
    expect(() => parseThemeQualifications({ nope: true }, ['th1'])).toThrow();
  });

  it('throws when a requested theme is missing from the response', () => {
    expect(() => parseThemeQualifications({ items: [themeItem('th1')] }, ['th1', 'th2'])).toThrow(
      /missing theme/
    );
  });

  it('throws when a theme is missing one of the four colour columns', () => {
    const bad = {
      id: 'th1',
      column_values: [
        { id: THEMA_QUAL_COLOURS.groen, linked_item_ids: [] },
        { id: THEMA_QUAL_COLOURS.oranje, linked_item_ids: [] },
        { id: THEMA_QUAL_COLOURS.rood, linked_item_ids: [] },
        // grijs missing
      ],
    };
    expect(() => parseThemeQualifications({ items: [bad] }, ['th1'])).toThrow(/colour column/);
  });

  it('throws when a colour column is present but not a relation (drift → no linked_item_ids)', () => {
    const drifted = {
      id: 'th1',
      column_values: [
        { id: THEMA_QUAL_COLOURS.groen, linked_item_ids: [] },
        { id: THEMA_QUAL_COLOURS.oranje, text: 'retyped to text' }, // no linked_item_ids
        { id: THEMA_QUAL_COLOURS.rood, linked_item_ids: [] },
        { id: THEMA_QUAL_COLOURS.grijs, linked_item_ids: [] },
      ],
    };
    expect(() => parseThemeQualifications({ items: [drifted] }, ['th1'])).toThrow(/not a relation/);
  });
});

describe('parseTrainingRead (fail-closed)', () => {
  it('maps a complete read', () => {
    const training = parseTrainingRead(
      trainingResponse([
        { id: 'rel', linked_item_ids: [10, 11] },
        { id: 'date', text: '2026-08-01' },
        { id: 'dur', text: '4' },
        { id: 'loc', text: 'Utrecht' },
      ]),
      COLS
    );
    expect(training).toEqual({
      externalItemId: 'tr1',
      themeExternalIds: ['10', '11'],
      locatie: 'Utrecht',
      datum: '2026-08-01',
      duurTraining: 4,
      updatedAt: '2026-07-01',
    });
  });

  it('allows a present-but-empty theme relation (genuine zero-theme → GEEN MATCH)', () => {
    const training = parseTrainingRead(
      trainingResponse([
        { id: 'rel', linked_item_ids: [] },
        { id: 'date', text: '2026-08-01' },
        { id: 'dur', text: '4' },
        { id: 'loc', text: 'Utrecht' },
      ]),
      COLS
    );
    expect(training?.themeExternalIds).toEqual([]);
  });

  it('throws when a requested column is absent (drift → FOUT, never a false GEEN MATCH)', () => {
    expect(() =>
      parseTrainingRead(
        trainingResponse([
          // themaRelation column ('rel') absent — drifted
          { id: 'date', text: '2026-08-01' },
          { id: 'dur', text: '4' },
          { id: 'loc', text: 'Utrecht' },
        ]),
        COLS
      )
    ).toThrow(/missing column/);
  });

  it('throws when the theme column is present but not a relation (drift, no linked_item_ids)', () => {
    expect(() =>
      parseTrainingRead(
        trainingResponse([
          { id: 'rel', text: 'retyped to text' }, // present but no linked_item_ids
          { id: 'date', text: '2026-08-01' },
          { id: 'dur', text: '4' },
          { id: 'loc', text: 'Utrecht' },
        ]),
        COLS
      )
    ).toThrow(/not a relation/);
  });

  it('returns null when the item is genuinely not found (valid empty items)', () => {
    expect(parseTrainingRead({ items: [] }, COLS)).toBeNull();
  });

  it('throws on a malformed response (not a silent not-found)', () => {
    expect(() => parseTrainingRead({ nope: true }, COLS)).toThrow(/malformed/);
  });

  it('rejects a partial/garbage duration (null, so the service fails it closed)', () => {
    const base = [
      { id: 'rel', linked_item_ids: [1] },
      { id: 'date', text: '2026-08-01' },
      { id: 'loc', text: 'Utrecht' },
    ];
    const uur = parseTrainingRead(trainingResponse([...base, { id: 'dur', text: '4 uur' }]), COLS);
    expect(uur?.duurTraining).toBeNull();
    const comma = parseTrainingRead(trainingResponse([...base, { id: 'dur', text: '4,5' }]), COLS);
    expect(comma?.duurTraining).toBe(4.5);
    const plain = parseTrainingRead(trainingResponse([...base, { id: 'dur', text: '4' }]), COLS);
    expect(plain?.duurTraining).toBe(4);
  });

  it('rejects a non-ISO or impossible calendar date (null → service invalid_date)', () => {
    const base = [
      { id: 'rel', linked_item_ids: [1] },
      { id: 'dur', text: '4' },
      { id: 'loc', text: 'Utrecht' },
    ];
    const garbage = parseTrainingRead(
      trainingResponse([...base, { id: 'date', text: 'next week' }]),
      COLS
    );
    expect(garbage?.datum).toBeNull();
    const impossible = parseTrainingRead(
      trainingResponse([...base, { id: 'date', text: '2026-13-45' }]),
      COLS
    );
    expect(impossible?.datum).toBeNull();
    const valid = parseTrainingRead(
      trainingResponse([...base, { id: 'date', text: '2026-08-01' }]),
      COLS
    );
    expect(valid?.datum).toBe('2026-08-01');
  });
});
