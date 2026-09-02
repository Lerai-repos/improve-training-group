import { BRIEFING_AGENDA_COLUMNS } from '@lib/briefing/columns';
import { agendaTrainerRelations, allTrainerRelationColumns } from './agenda-boards';
import { IE_STATUS_COLUMN } from './record';
import { resolveLabelCode } from '@lib/labels';

import type { LabelCode } from '@lib/labels';
import type { ReportTraining } from './types';

/**
 * De gegevens van één training van het agendabord, voor het evaluatierapport.
 *
 * Bewust een LICHTE lezer, geen hergebruik van `lib/briefing/read.ts`. Die leest vier
 * borden en haalt de contactpersoon via Opportunity → Contacten op, omdat een briefing ook
 * een telefoonnummer nodig heeft. Het rapport gebruikt alleen de náám, in de aanhef, en die
 * staat gewoon op de agenda (`tekst8`, 690/815 gevuld). Drie extra bordbevragingen voor een
 * veld dat we niet gebruiken is de verkeerde ruil in een dagjob die dit voor elke training
 * van gisteren doet.
 *
 * De kolom-ids komen wél uit `BRIEFING_AGENDA_COLUMNS`, zodat er één plek is waar ze staan.
 */

const C = BRIEFING_AGENDA_COLUMNS;

export interface TrainingForReport extends ReportTraining {
  /** De labelcode, al door de aliaslijst gehaald. `null` als het label onbekend is. */
  readonly labelCode: LabelCode | null;
  /** Ruwe inhoud van de IE-codekolom; de toekenning splitst hem zelf. */
  readonly rawIeCode: string | null;
  /** Wat er in `status23` stond, ook als wij het niet kennen — voor de foutmelding. */
  readonly rawLabel: string;
  /**
   * De huidige waarde van `IE. Trainer`.
   *
   * Nodig om te kunnen bepalen of een eerdere `Onvindbaar` van ONS is en dus opgeruimd mag
   * worden, zonder een handmatige `Verzonden` of `Staat klaar` te overschrijven.
   */
  readonly ieStatus: string;
}

interface RelationCell {
  id: string;
  text?: string | null;
  linked_items?: Array<{ id: string; name: string }> | null;
}

interface AgendaItem {
  id: string;
  name: string;
  /** Welke jaargang; bepaalt WELKE trainerrelatie de juiste is. */
  board?: { id: string } | null;
  column_values?: RelationCell[] | null;
}

interface AgendaReader {
  query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ items?: AgendaItem[] | null }>;
}

const FIELDS = [
  C.klanttitel,
  C.contactpersoonNaam,
  C.label,
  C.ieCode,
  C.qr,
  IE_STATUS_COLUMN,
] as const;

const cell = (item: AgendaItem, id: string): RelationCell | undefined =>
  (item.column_values ?? []).find((c) => c.id === id);

const textOf = (item: AgendaItem, id: string): string => (cell(item, id)?.text ?? '').trim();

/**
 * Lees één training.
 *
 * **Beide trainerkolommen**, lead én co-trainers, in die volgorde. De lead hoort als eerste
 * in "onze trainers Jan en Piet" te staan; dat is de volgorde waarin ITG het zelf schrijft.
 *
 * **De trainerrelatie verschilt PER JAARGANG** — 2026 gebruikt `board_relation_mkz4y7tb`,
 * 2025 `board_relation_mkz4w78`, en 2025 heeft helemaal geen co-trainerkolom. Die ids komen
 * uit `AGENDA_HISTORY_BOARDS` via `./agenda-boards`, niet uit een eigen tabel. Er wordt naar
 * álle bekende relatie-ids gevraagd en pas ná het lezen van `board { id }` gekozen welke
 * ervan tellen. Eén projectie, geen tweede bordbevraging.
 *
 * Werpt op een onbekend agendabord in plaats van 2026 te gokken: een kolom-id van het
 * verkeerde bord geeft bij Monday geen fout maar een LEGE relatie, en een rapport dat
 * "onze trainer" zonder naam schrijft ziet er verder volkomen normaal uit.
 */
export async function readTrainingForReport(
  client: AgendaReader,
  itemId: string
): Promise<TrainingForReport | null> {
  const ids = [...FIELDS, ...allTrainerRelationColumns()].map((id) => `"${id}"`).join(', ');
  const data = await client.query(
    `query ($i: [ID!]) { items(ids: $i) { id name board { id } ` +
      `column_values(ids: [${ids}]) { id text ` +
      `... on BoardRelationValue { linked_items { id name } } } } }`,
    { i: [itemId] }
  );

  const item = data.items?.[0];
  if (item === undefined) {
    return null;
  }

  const boardId = item.board?.id ?? '';
  const relations = agendaTrainerRelations(boardId);
  if (relations === null) {
    throw new Error(
      `Agenda-item ${itemId} staat op bord ${boardId || '(onbekend)'}, en van dat bord weten ` +
        'we niet welke kolom de trainers draagt. Zonder dat zou het rapport "onze trainer" ' +
        'zonder naam schrijven. Vul de jaargang aan in `agendaTrainerRelations`.'
    );
  }

  /**
   * Ontdubbelen op ITEM-ID, met de lead eerst.
   *
   * Dezelfde persoon kan in beide kolommen staan — `lib/briefing/read.ts` filtert daar al op
   * (`coIds.filter((id) => !leadIds.includes(id))`) en dit doet hetzelfde. Zonder dat komt er
   * "onze trainers Jan en Jan" in een brief aan een klant te staan, mét het meervoud, en dat
   * ziet er verder volkomen verzorgd uit.
   *
   * Op id en niet op naam: twee trainers kunnen dezelfde naam hebben, en die mogen niet
   * samenvallen tot één.
   */
  const trainerColumns = relations.co === null ? [relations.lead] : [relations.lead, relations.co];
  const seen = new Set<string>();
  const trainerNamen: string[] = [];
  for (const columnId of trainerColumns) {
    for (const linked of cell(item, columnId)?.linked_items ?? []) {
      const naam = linked.name.trim();
      if (naam === '' || seen.has(linked.id)) {
        continue;
      }
      seen.add(linked.id);
      trainerNamen.push(naam);
    }
  }

  const rawLabel = textOf(item, C.label);
  const rawIeCode = textOf(item, C.ieCode);

  return {
    itemId: item.id,
    /**
     * De klanttitelkolom, en anders de itemnaam.
     *
     * De titel loopt middenin een zin naar de klant ("met veel plezier de training X
     * gefaciliteerd"), dus leeg laten is geen optie. De itemnaam is wat de planner zelf
     * heeft getypt en daarmee de best beschikbare terugval.
     */
    klanttitel: textOf(item, C.klanttitel) || item.name.trim(),
    contactPersoon: textOf(item, C.contactpersoonNaam),
    trainerNamen,
    labelCode: rawLabel === '' ? null : resolveLabelCode(rawLabel),
    rawIeCode: rawIeCode === '' ? null : rawIeCode,
    rawLabel,
    ieStatus: textOf(item, IE_STATUS_COLUMN),
  };
}
