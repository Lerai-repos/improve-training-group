import type { RawMondayItem, TrainingColumnMap } from '../decode';

/**
 * Raw Monday payloads used ONLY to test the transport→domain decoder. They
 * reproduce the v2025-04 gotcha: `board_relation` columns have `value: null`
 * with ids only in `linked_item_ids`, and mirror columns have null `text`.
 */

// Real 2026 Agenda column ids (monday.md / platform-structures):
//   status23 = Label, tekst7 = Locatie, lookup_mkszzfvr = Bedrijf (mirror),
//   nummers_mkmvc0rk = Exacte duur, board_relation_mkz4y7tb/mkz4920y = Trainer/Thema.
export const AGENDA_2026_COLUMN_MAP: TrainingColumnMap = {
  trainerRelation: 'board_relation_mkz4y7tb',
  themaRelation: 'board_relation_mkz4920y',
  companyMirror: 'lookup_mkszzfvr',
  datum: 'datum_1',
  duur: 'nummers_mkmvc0rk',
  ieCode: 'tekst_mkn58pt6',
  locatie: 'tekst7',
  label: 'status23',
  omzet: 'nummers', // 'O' revenue column, EUR
};

export const RAW_TRAINING_ITEM: RawMondayItem = {
  id: '5087400001',
  name: 'Training X',
  board: { id: '5087396949' },
  group: { id: 'topics' },
  column_values: [
    {
      id: 'board_relation_mkz4y7tb',
      type: 'board_relation',
      text: null,
      // The gotcha: value is null; ids live in linked_item_ids.
      value: null,
      linked_item_ids: ['1661150001', '1661150002'],
    },
    {
      id: 'board_relation_mkz4920y',
      type: 'board_relation',
      text: null,
      value: null,
      linked_item_ids: ['5067920001'],
    },
    {
      // Mirror gotcha: text/value null; the value is in display_value.
      id: 'lookup_mkszzfvr',
      type: 'mirror',
      text: null,
      value: null,
      display_value: 'Acme BV',
    },
    { id: 'datum_1', type: 'date', text: '2026-03-15', value: '{"date":"2026-03-15"}' },
    { id: 'nummers_mkmvc0rk', type: 'numeric', text: '3', value: '3' },
    { id: 'status23', type: 'status', text: 'IT', value: '{"index":0}' },
    { id: 'tekst_mkn58pt6', type: 'text', text: 'IE-2026-001', value: 'IE-2026-001' },
    { id: 'tekst7', type: 'text', text: 'Amsterdam', value: 'Amsterdam' },
    { id: 'nummers', type: 'numeric', text: '1250.50', value: '1250.50' },
  ],
};

// A training with no linked trainers/themes and empty numerics — exercises the
// "coverage gap" style empties without throwing.
export const RAW_TRAINING_ITEM_EMPTY: RawMondayItem = {
  id: '5087400002',
  name: 'Unassigned training',
  board: { id: '5087396949' },
  group: null,
  column_values: [
    {
      id: 'board_relation_mkz4y7tb',
      type: 'board_relation',
      text: null,
      value: null,
      linked_item_ids: [],
    },
    {
      id: 'board_relation_mkz4920y',
      type: 'board_relation',
      text: null,
      value: null,
      linked_item_ids: null,
    },
    { id: 'nummers_mkmvc0rk', type: 'numeric', text: '', value: null },
    { id: 'status23', type: 'status', text: null, value: null },
    { id: 'tekst_mkn58pt6', type: 'text', text: '', value: null },
  ],
};
