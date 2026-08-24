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

/** The Opportunities board the klant relation points at, on both jaargangen. */
const KLANTEN_BOARD = '1279052045';

export interface AgendaHistoryColumns {
  readonly boardId: string;
  readonly jaargang: '2026' | '2025';
  /** De **leadtrainer**-relatie; sinds 21-Aug-2026 betekent deze kolom alleen de lead. */
  readonly trainerRelation: string;
  /**
   * De co-trainerrelatie, als de jaargang hem heeft.
   *
   * Zonder dit schrijft de evaluatiejoin een sessie alléén toe aan de lead, en verdwijnt
   * een co-trainer stil uit zijn eigen cijfers zodra ITG hem verplaatst. Agenda 2025 heeft
   * geen co-trainerkolom, dus daar blijft dit leeg.
   */
  readonly coTrainerRelation?: string;
  readonly themaRelation: string;
  /**
   * The klant link — the RELATION, not the `lookup_mkszzfvr` mirror.
   *
   * Mirrors read back null through the API, and the item name is unusable as a key
   * (`Summa College` vs `Summa College (copy)` is one client, 57 responses). Same column
   * id on both jaargangen, unlike the trainer and thema relations.
   *
   * Load-bearing since the shared-code rule: it decides whether trainings sharing an IE
   * code are one session or a collision, so a wrong value silently moves responses
   * between clients.
   */
  readonly klantRelation: string;
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
  coTrainerRelation: 'itg_cotrainers',
  themaRelation: 'board_relation_mkz4920y',
  klantRelation: 'board_relation',
  ieCode: 'tekst_mkn58pt6',
  datum: 'datum_1',
  minimumItems: 600,
};

export const AGENDA_2025_HISTORY: AgendaHistoryColumns = {
  boardId: '1703587792',
  jaargang: '2025',
  trainerRelation: 'board_relation_mkz4w78',
  themaRelation: 'board_relation_mkz4hjnt',
  klantRelation: 'board_relation',
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
 * De trainerkolommen van deze jaargang, lead eerst.
 *
 * Eén plek, zodat de query en de decodeerstap niet uit elkaar kunnen lopen: vraagt de query
 * de co-trainerkolom niet op, dan meldt Monday niets en leest de decodeerstap hem als
 * "geen co-trainers".
 */
export function trainerRelationColumns(
  columns: AgendaHistoryColumns
): readonly string[] {
  return columns.coTrainerRelation === undefined
    ? [columns.trainerRelation]
    : [columns.trainerRelation, columns.coTrainerRelation];
}

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
    ...(columns.coTrainerRelation === undefined
      ? []
      : [
          {
            id: columns.coTrainerRelation,
            type: 'board_relation',
            settingsIncludes: [`"boardIds":[${TRAINERS_BOARD}]`],
          },
        ]),
    {
      id: columns.themaRelation,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${THEMAS_BOARD}]`],
    },
    {
      id: columns.klantRelation,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${KLANTEN_BOARD}]`],
    },
    { id: columns.ieCode, type: 'text' },
    { id: columns.datum, type: 'date' },
  ];
}
