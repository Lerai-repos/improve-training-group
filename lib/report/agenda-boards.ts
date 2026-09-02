import { AGENDA_2026_HISTORY, AGENDA_HISTORY_BOARDS } from '@lib/evaluations';
import { agendaBoardId, AGENDA_2026_PRODUCTION_BOARD } from '@lib/monday/board-config';

import type { AgendaHistoryColumns } from '@lib/evaluations';

/**
 * Welke agendaborden het rapport leest, en met welke kolommen — mét de testoverride.
 *
 * **Het gat dat dit dichtzet.** `MONDAY_AGENDA_BOARD_ID` wijst de hele pijplijn naar een
 * KOPIE van Agenda 2026; `docs/m2b/README.md` beschrijft hem als *"every Agenda read + the
 * status write"*. Maar `readAgendaHistory` leest standaard de vaste productieborden, terwijl
 * de dagjob zijn resultaten filtert op `agendaBoardId()`. Met de override aan leverde dat
 * nul overeenkomsten op: de job draaide, meldde 0 trainingen en deed niets — precies het
 * stille niets-doen waar het bordoverzicht in de documentatie voor waarschuwt.
 *
 * Een Monday-bordkopie behoudt élk kolom-id en groep-id, dus de 2026-kolommen kloppen
 * onverkort voor de kopie; alleen het bord-id verschilt.
 */

/**
 * Bij een override ALLEEN de kopie, niet ook productie-2025.
 *
 * De override bestaat om van ITG's echte gegevens af te blijven. Er een productiebord naast
 * zetten zou testtrainingen en echte trainingen in één toekenning gooien, en dan kan een
 * gedeelde code een echte klant aan een testrij koppelen.
 */
export function reportAgendaBoards(): readonly AgendaHistoryColumns[] {
  const board = agendaBoardId();
  if (board === AGENDA_2026_PRODUCTION_BOARD) {
    return AGENDA_HISTORY_BOARDS;
  }
  return [
    {
      ...AGENDA_2026_HISTORY,
      boardId: board,
      // `jaargang` is een vaste unie ('2026' | '2025'); de kopie IS een 2026-bord.
      jaargang: '2026',
      /**
       * De ondergrens vervalt op een kopie.
       *
       * `minimumItems` beschermt de statistiek tegen een bord dat plots te weinig rijen
       * teruggeeft, maar een testkopie heeft er legitiem een handvol. De drempel van 600
       * zou elke testrun laten falen op een gegrond aantal.
       */
      minimumItems: 0,
    },
  ];
}

/** De trainerrelaties van één bord, of `null` als we dat bord niet kennen. */
export interface TrainerRelations {
  readonly lead: string;
  /** `null` op een jaargang waar de co-trainerkolom niet bestaat, zoals 2025. */
  readonly co: string | null;
}

/**
 * Welke kolommen de trainers dragen op dit bord.
 *
 * Afgeleid van `AGENDA_HISTORY_BOARDS` en niet uit een eigen tabel: die ids stonden er al
 * (2025 draagt de trainers in `board_relation_mkz4w78` en heeft geen co-trainerkolom), en
 * een tweede lijst met dezelfde waarden is een lijst die gaat afwijken.
 *
 * `null` en geen terugval op 2026: een kolom-id van het verkeerde bord levert bij Monday
 * geen fout op maar een LEGE relatie, en dat leest als "er stond geen trainer bij deze
 * training".
 */
export function agendaTrainerRelations(boardId: string): TrainerRelations | null {
  const board = reportAgendaBoards().find((b) => b.boardId === boardId);
  if (board === undefined) {
    return null;
  }
  return { lead: board.trainerRelation, co: board.coTrainerRelation ?? null };
}

/** Elk trainerrelatie-id dat op enig gelezen agendabord voorkomt. Voor één projectie. */
export function allTrainerRelationColumns(): readonly string[] {
  const ids = reportAgendaBoards().flatMap((b) =>
    b.coTrainerRelation === undefined
      ? [b.trainerRelation]
      : [b.trainerRelation, b.coTrainerRelation]
  );
  return [...new Set(ids)];
}
