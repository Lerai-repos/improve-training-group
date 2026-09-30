import type { ExpectedColumn } from '@lib/monday/board-config';
import type { TekstStatus } from './types';

/** De kolom-ids op het bord Briefingteksten. Ids, geen titels: ITG mag kolommen hernoemen. */
export const TEKST_COLUMNS = {
  kop: 'itg_kop',
  tekst: 'itg_tekst',
  status: 'itg_status',
  melding: 'itg_melding',
  uitleg: 'itg_uitleg',
  sleutel: 'itg_sleutel',
} as const;

/** Wat de lezer nodig heeft. Uitleg ontbreekt met opzet: zonder die kolom werkt alles nog. */
export const TEKST_EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { id: TEKST_COLUMNS.kop, type: 'text' },
  { id: TEKST_COLUMNS.tekst, type: 'long_text' },
  { id: TEKST_COLUMNS.status, type: 'status' },
  { id: TEKST_COLUMNS.melding, type: 'text' },
  { id: TEKST_COLUMNS.sleutel, type: 'text' },
];

/**
 * De labels van Status, met hun index.
 *
 * Bij Monday IS de index de kleur (zie `HUISWERK_WEL`): 1 groen, 2 rood, 0 oranje, 3 een
 * blauwtint. Index 5 is de ingebouwde lege plek en wordt nergens in deze codebase gebruikt.
 */
export const STATUS_LABELS: Readonly<Record<number, TekstStatus>> = {
  0: 'Leeg',
  1: 'OK',
  2: 'Fout',
  3: 'Niet gekoppeld',
};

export interface TekstColumnSpec {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly defaults: string | null;
}

/** In aanmaakvolgorde: wat ITG bewerkt links, wat wij invullen rechts. */
export const TEKST_COLUMN_SPECS: readonly TekstColumnSpec[] = [
  { id: TEKST_COLUMNS.kop, title: 'Kop', type: 'text', defaults: null },
  { id: TEKST_COLUMNS.tekst, title: 'Tekst', type: 'long_text', defaults: null },
  {
    id: TEKST_COLUMNS.status,
    title: 'Status',
    type: 'status',
    defaults: JSON.stringify({ labels: STATUS_LABELS }),
  },
  { id: TEKST_COLUMNS.melding, title: 'Melding', type: 'text', defaults: null },
  { id: TEKST_COLUMNS.uitleg, title: 'Uitleg', type: 'long_text', defaults: null },
  { id: TEKST_COLUMNS.sleutel, title: 'Sleutel', type: 'text', defaults: null },
];
