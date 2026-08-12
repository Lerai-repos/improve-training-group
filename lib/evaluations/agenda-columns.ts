/**
 * Which columns hold the trainer, thema, IE-code and date — **per jaargang**.
 *
 * This is the trap the whole subsystem is built around. Agenda 2025 uses different
 * relation column ids from Agenda 2026, and Monday answers a request for a column it
 * does not recognise by omitting it rather than erroring. Reading 2025 with the 2026
 * ids therefore makes 202 of 340 trainings look trainer-less, with no error anywhere:
 * a smaller stats set that looks entirely plausible.
 *
 * The ids travel with each call rather than sitting in module state, exactly as
 * `assignments.ts` does, and `agendaHistoryExpectedColumns` gives `assertColumns`
 * enough to catch the subtler version — a relation that still exists, still has the
 * right type, and now points at a different board.
 *
 * Deliberately NOT in `board-config.ts`: that file's Agenda constants are scoped to the
 * single, env-overridable board the engine runs against. This map is inherently
 * multi-board, and honouring `MONDAY_AGENDA_BOARD_ID` here would silently halve the
 * historical corpus by aiming it at a test copy.
 */

import {
  AGENDA_2026_PRODUCTION_BOARD,
  THEMAS_BOARD,
  TRAINERS_BOARD,
  type ExpectedColumn,
} from '@lib/monday/board-config';

export interface AgendaHistoryColumns {
  readonly boardId: string;
  readonly jaargang: '2026' | '2025';
  readonly trainerRelation: string;
  readonly themaRelation: string;
  readonly ieCode: string;
  readonly datum: string;
  /**
   * A floor on how many items the board must return.
   *
   * A board that answers with 40 items is syntactically perfect and semantically
   * catastrophic: the roll-up would drop every pair it no longer sees, and the nightly
   * delta would blank them. Crude on purpose — it needs no state and cannot itself
   * fail. Measured sizes are 776 (2026) and 943 (2025).
   */
  readonly minimumItems: number;
}

export const AGENDA_2026_HISTORY: AgendaHistoryColumns = {
  boardId: AGENDA_2026_PRODUCTION_BOARD,
  jaargang: '2026',
  trainerRelation: 'board_relation_mkz4y7tb',
  themaRelation: 'board_relation_mkz4920y',
  ieCode: 'tekst_mkn58pt6',
  datum: 'datum_1',
  minimumItems: 600,
};

export const AGENDA_2025_HISTORY: AgendaHistoryColumns = {
  boardId: '1703587792',
  jaargang: '2025',
  trainerRelation: 'board_relation_mkz4w78',
  themaRelation: 'board_relation_mkz4hjnt',
  ieCode: 'tekst_mkn58pt6',
  datum: 'datum_1',
  minimumItems: 800,
};

/**
 * Every jaargang the statistics are built from.
 *
 * Agenda 2024 has no Monday board, so its evaluations can never attach to anything —
 * that is a documented, accepted loss, not an omission to fix here.
 */
export const AGENDA_HISTORY_BOARDS: readonly AgendaHistoryColumns[] = [
  AGENDA_2026_HISTORY,
  AGENDA_2025_HISTORY,
];

/**
 * What `assertColumns` should insist on.
 *
 * `settingsIncludes` is the load-bearing part: a missing column is caught by the id, but
 * a relation repointed at a different board keeps both its id and its type, and would
 * quietly return the wrong trainers.
 */
export function agendaHistoryExpectedColumns(
  columns: AgendaHistoryColumns
): readonly ExpectedColumn[] {
  return [
    {
      id: columns.trainerRelation,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${TRAINERS_BOARD}]`],
    },
    {
      id: columns.themaRelation,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${THEMAS_BOARD}]`],
    },
    { id: columns.ieCode, type: 'text' },
    { id: columns.datum, type: 'date' },
  ];
}
