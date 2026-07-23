import { describe, expect, it } from 'vitest';

import { decodeTraining, linkedItemIds, mirrorValue, type RawMondayItem } from '../decode';
import {
  AGENDA_2026_COLUMN_MAP,
  RAW_TRAINING_ITEM,
  RAW_TRAINING_ITEM_EMPTY,
} from '../__fixtures__/raw-items';

describe('linkedItemIds', () => {
  it('reads ids from linked_item_ids even though value is null (v2025-04 gotcha)', () => {
    expect(linkedItemIds(RAW_TRAINING_ITEM, 'board_relation_mkz4y7tb')).toEqual([
      '1661150001',
      '1661150002',
    ]);
  });

  it('returns [] for an empty or null relation', () => {
    expect(linkedItemIds(RAW_TRAINING_ITEM_EMPTY, 'board_relation_mkz4y7tb')).toEqual([]);
    expect(linkedItemIds(RAW_TRAINING_ITEM_EMPTY, 'board_relation_mkz4920y')).toEqual([]);
  });
});

describe('mirrorValue', () => {
  it('reads display_value even though text/value are null (mirror gotcha)', () => {
    expect(mirrorValue(RAW_TRAINING_ITEM, 'lookup_mkszzfvr')).toBe('Acme BV');
  });

  it('returns null when the column is absent', () => {
    expect(mirrorValue(RAW_TRAINING_ITEM, 'not_a_column')).toBeNull();
  });
});

describe('decodeTraining', () => {
  it('normalizes a full raw item using the real Agenda column ids', () => {
    const t = decodeTraining(RAW_TRAINING_ITEM, AGENDA_2026_COLUMN_MAP);

    expect(t.externalItemId).toBe('5087400001');
    expect(t.externalBoardId).toBe('5087396949');
    expect(t.externalGroupId).toBe('topics');
    expect(t.datum).toBe('2026-03-15');
    expect(t.duurTraining).toBe(3);
    expect(t.ieCode).toBe('IE-2026-001');
    expect(t.locatie).toBe('Amsterdam'); // tekst7
    expect(t.label).toBe('IT'); // status23 (the Label column)
    expect(t.omzetCents).toBe(125050); // nummers: €1250.50 → cents
    expect(t.companyName).toBe('Acme BV'); // lookup_mkszzfvr mirror
    expect(t.trainerExternalIds).toEqual(['1661150001', '1661150002']);
    expect(t.themaExternalIds).toEqual(['5067920001']);

    // Derived / connection-phase fields are intentionally not read here.
    expect(t.status).toBeNull();
    expect(t.klantExternalIds).toEqual([]);
  });

  it('decodes an empty item without throwing (coverage-gap style)', () => {
    const t = decodeTraining(RAW_TRAINING_ITEM_EMPTY, AGENDA_2026_COLUMN_MAP);

    expect(t.trainerExternalIds).toEqual([]);
    expect(t.themaExternalIds).toEqual([]);
    expect(t.duurTraining).toBeNull();
    expect(t.locatie).toBeNull();
    expect(t.companyName).toBeNull();
  });

  it('returns null (not NaN) for non-numeric number columns', () => {
    const raw: RawMondayItem = {
      id: 'x',
      name: 'x',
      board: { id: 'b' },
      group: null,
      column_values: [
        { id: 'nummers', type: 'numeric', text: '1.234,50', value: null }, // Dutch format
        { id: 'nummers_mkmvc0rk', type: 'numeric', text: 'n/a', value: null },
      ],
    };
    const t = decodeTraining(raw, AGENDA_2026_COLUMN_MAP);
    expect(t.omzetCents).toBeNull();
    expect(t.duurTraining).toBeNull();
  });
});
