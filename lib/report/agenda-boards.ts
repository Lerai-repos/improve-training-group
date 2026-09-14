import type { AgendaHistoryColumns } from '@lib/evaluations';

/**
 * Welke kolom op welk agendabord de trainers en de thema's draagt.
 *
 * De borden zelf komen uit `loadAgendaBoards`, dat ze per run ontdekt en daarbij de
 * testoverride toepast. Hier worden ze meegegeven in plaats van uit een vaste lijst gelezen,
 * zodat een nieuwe jaargang zonder codewijziging meedoet.
 */

/** De trainerrelaties van één bord. */
export interface TrainerRelations {
  readonly lead: string;
  /** `null` op een jaargang waar de co-trainerkolom niet bestaat, zoals 2025. */
  readonly co: string | null;
}

/**
 * Welke kolommen de trainers dragen op dit bord, of `null` als het geen bekend agendabord is.
 *
 * `null` en geen terugval op 2026: een kolom-id van het verkeerde bord levert bij Monday
 * geen fout op maar een LEGE relatie, en dat leest als "er stond geen trainer bij deze
 * training".
 */
export function agendaTrainerRelations(
  boards: readonly AgendaHistoryColumns[],
  boardId: string
): TrainerRelations | null {
  const board = boards.find((b) => b.boardId === boardId);
  if (board === undefined) {
    return null;
  }
  return { lead: board.trainerRelation, co: board.coTrainerRelation ?? null };
}

/**
 * De themarelatie van dit bord, of `null` als we het bord niet kennen.
 *
 * Om dezelfde reden apart als `agendaTrainerRelations`: 2026 draagt de thema's in
 * `board_relation_mkz4920y` en 2025 in `board_relation_mkz4hjnt`. Een id van het verkeerde
 * bord geeft geen fout maar een LEGE relatie, en dan schrijft de aftersalesmail "de sessie"
 * waar "de sessie over Onderhandelen" hoorde te staan.
 */
export function agendaThemaRelation(
  boards: readonly AgendaHistoryColumns[],
  boardId: string
): string | null {
  return boards.find((b) => b.boardId === boardId)?.themaRelation ?? null;
}

/** Elk themarelatie-id dat op enig agendabord voorkomt. Voor één projectie. */
export function allThemaRelationColumns(
  boards: readonly AgendaHistoryColumns[]
): readonly string[] {
  return [...new Set(boards.map((b) => b.themaRelation))];
}

/** Elk trainerrelatie-id dat op enig agendabord voorkomt. Voor één projectie. */
export function allTrainerRelationColumns(
  boards: readonly AgendaHistoryColumns[]
): readonly string[] {
  const ids = boards.flatMap((b) =>
    b.coTrainerRelation === undefined
      ? [b.trainerRelation]
      : [b.trainerRelation, b.coTrainerRelation]
  );
  return [...new Set(ids)];
}
