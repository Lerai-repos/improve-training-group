import { liveAgendaBoards } from '@lib/evaluations';

import { bepaalOvername } from './regel';

import type { AgendaBoard, AgendaBoardSet } from '@lib/evaluations';
import type { Kandidaat } from './read';
import type { AgendaStand, Conflict, Kolomwaarden, OpportunityStand, Overname } from './regel';

export interface Schrijfactie {
  readonly boardId: string;
  readonly itemId: string;
  readonly naam: string;
  readonly waarden: Kolomwaarden;
}

export interface OvernameDeps {
  /** Per run ontdekt, zodat een nieuwe jaargang vanzelf meedoet. */
  readonly readAgendaBoards: () => Promise<AgendaBoardSet>;
  /** De komende trainingen met een Opportunity op één bord, met wat er nu in de doelcellen staat. */
  readonly readKandidaten: (board: AgendaBoard) => Promise<readonly Kandidaat[]>;
  readonly readOpportunities: (
    ids: readonly string[]
  ) => Promise<ReadonlyMap<string, OpportunityStand>>;
  /**
   * Eén training en haar Opportunity opnieuw lezen, vlak voor het schrijven.
   *
   * `null` als er niets meer te vergelijken valt: de training is weg, hangt intussen aan een
   * andere Opportunity, of die Opportunity bestaat niet meer. Dan wordt er niet geschreven; de
   * volgende nacht ziet de nieuwe toestand gewoon in de scan.
   */
  readonly herlees: (
    rij: Kandidaat
  ) => Promise<{ readonly agenda: AgendaStand; readonly stand: OpportunityStand } | null>;
  /** `null` in een droogloop: alles wordt berekend, niets geschreven. */
  readonly writer: ((actie: Schrijfactie) => Promise<void>) | null;
}

export interface TrainingConflict {
  readonly boardId: string;
  readonly itemId: string;
  readonly naam: string;
  readonly conflicten: readonly Conflict[];
}

export interface Mislukking {
  readonly bord: string;
  /** Weggelaten als het hele bord niet te lezen was. */
  readonly training?: string;
  readonly fout: string;
}

export interface OvernameReport {
  readonly dryRun: boolean;
  /** De namen van de borden die zijn gelezen. */
  readonly borden: readonly string[];
  /** Komende trainingen met een Opportunity. */
  readonly trainingen: number;
  /** Waarvan de Opportunity minstens één van de drie vragen beantwoordt. */
  readonly metAntwoord: number;
  /** In een droogloop: wat er geschreven zóu worden. */
  readonly geschreven: readonly Schrijfactie[];
  readonly conflicten: readonly TrainingConflict[];
  readonly mislukt: readonly Mislukking[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const beantwoord = (stand: OpportunityStand): boolean =>
  stand.voorbereidend !== null || stand.huiswerk !== null || stand.cyclus !== null;

/**
 * De antwoorden van de Opportunity overnemen op de komende trainingen.
 *
 * Dirkje, 17-Sep-2026: de accountmanager beantwoordt voorbereidende opdracht, huiswerk en
 * cyclus al in de Opportunity-fase, maar bij de conversie naar de agenda komt daar niets van
 * mee. Dit vult de lege agendacellen 's nachts bij; wat er al staat blijft staan (zie
 * `bepaalOvername`). Elke nacht opnieuw, dus ook een Opportunity die pas ná de conversie wordt
 * beantwoord bereikt de training nog.
 *
 * Per bord en per training afgeschermd: één bord zonder kolom of één geweigerde schrijfactie
 * houdt de rest niet op, en staat in `mislukt` zodat de route er een 500 van kan maken. De
 * Opportunity-lezing is de gedeelde invoer en werpt wél door — zonder die is er niets te
 * vergelijken.
 *
 * Geen grendel: elke schrijfactie zet een lege cel op een waarde die uit de Opportunity volgt,
 * dus twee runs tegelijk doen hoogstens hetzelfde twee keer.
 */
export async function runOvername(deps: OvernameDeps): Promise<OvernameReport> {
  const dryRun = deps.writer === null;
  const borden = liveAgendaBoards(await deps.readAgendaBoards());

  const mislukt: Mislukking[] = [];
  const perBord: { board: AgendaBoard; kandidaten: readonly Kandidaat[] }[] = [];
  for (const board of borden) {
    try {
      perBord.push({ board, kandidaten: await deps.readKandidaten(board) });
    } catch (error) {
      mislukt.push({ bord: board.naam, fout: message(error) });
    }
  }

  const kandidaten = perBord.flatMap((b) => b.kandidaten);
  const opportunityIds = [...new Set(kandidaten.map((k) => k.opportunityItemId))];
  const opportunities =
    opportunityIds.length === 0 ? new Map() : await deps.readOpportunities(opportunityIds);

  const geschreven: Schrijfactie[] = [];
  const conflicten: TrainingConflict[] = [];
  let metAntwoord = 0;

  for (const { board, kandidaten: rijen } of perBord) {
    for (const rij of rijen) {
      const stand = opportunities.get(rij.opportunityItemId);
      if (stand === undefined || !beantwoord(stand)) {
        continue;
      }
      metAntwoord += 1;
      const gescand = bepaalOvername(rij.agenda, stand);

      /**
       * De scan is op dit punt seconden tot een minuut oud, en Monday kent geen voorwaardelijke
       * schrijfactie. Wie in die tijd zelf een cel vulde zou zijn keuze overschreven zien met
       * een antwoord dat wij "leeg" noemden. Daarom wordt een training waar iets te schrijven
       * lijkt eerst opnieuw gelezen, en telt alleen wat er dán nog leeg is. Het venster krimpt
       * zo van de looptijd van de run tot één aanroep; helemaal dicht kan het niet.
       *
       * Een droogloop schrijft niet en herleest dus ook niet.
       */
      let uit: Overname | null = gescand;
      if (deps.writer !== null && Object.keys(gescand.schrijf).length > 0) {
        try {
          const vers = await deps.herlees(rij);
          uit = vers === null ? null : bepaalOvername(vers.agenda, vers.stand);
        } catch (error) {
          mislukt.push({ bord: board.naam, training: rij.itemId, fout: message(error) });
          continue;
        }
      }
      if (uit === null) {
        continue;
      }

      if (uit.conflicten.length > 0) {
        conflicten.push({
          boardId: rij.boardId,
          itemId: rij.itemId,
          naam: rij.naam,
          conflicten: uit.conflicten,
        });
      }
      if (Object.keys(uit.schrijf).length === 0) {
        continue;
      }
      const actie: Schrijfactie = {
        boardId: rij.boardId,
        itemId: rij.itemId,
        naam: rij.naam,
        waarden: uit.schrijf,
      };
      if (deps.writer !== null) {
        try {
          await deps.writer(actie);
        } catch (error) {
          mislukt.push({ bord: board.naam, training: rij.itemId, fout: message(error) });
          continue;
        }
      }
      geschreven.push(actie);
    }
  }

  return {
    dryRun,
    borden: perBord.map((b) => b.board.naam),
    trainingen: kandidaten.length,
    metAntwoord,
    geschreven,
    conflicten,
    mislukt,
  };
}
