import { BRIEFINGS_BOARD, BRIEFINGS_COLUMNS, BRIEFING_AGENDA_COLUMNS } from './columns';

import type { RecipientRole } from './recipients';
import type { MondayMutationClient } from '@lib/monday/mutate';

/**
 * Wat er ná het schrijven van de documenten in Monday wordt vastgelegd.
 *
 * Twee dingen: de statuskolom `Brie` op de training, en één rij per gegenereerd document op
 * het Briefings-bord. Allebei bookkeeping — het document zelf staat dan al veilig in
 * SharePoint — en dat bepaalt hoe er met fouten wordt omgegaan; zie `recordGeneration`.
 */

/** De labels die op `Brie` bestaan. `Verzonden` zet de adviseur zelf, wij nooit. */
export type BrieStatus = 'Staat klaar' | 'Begonnen, niet klaar';

const ROL_LABEL: Record<RecipientRole, string> = {
  lead: 'Leadtrainer',
  co: 'Co-trainer',
  acteur: 'Trainingsacteur',
};

export interface BriefingRow {
  /** Het agenda-item waar deze briefing bij hoort; vult ook de drie spiegelkolommen. */
  readonly trainingItemId: string;
  readonly filename: string;
  readonly ontvanger: string;
  readonly role: RecipientRole;
  readonly url: string;
  /** `YYYY-MM-DD`. */
  readonly gegenereerdOp: string;
}

export interface BriefingRecorder {
  setBrie(itemId: string, status: BrieStatus): Promise<void>;
  addRow(row: BriefingRow): Promise<string>;
}

const SET_STATUS = `
mutation ($board: ID!, $item: ID!, $column: String!, $value: String!) {
  change_simple_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) {
    id
  }
}`;

const CREATE_ITEM = `
mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
  create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) {
    id
  }
}`;

/**
 * De MUTATIE-client, niet de leesclient.
 *
 * `createMondayGraphQLClient` weigert elk document waar `mutation` in staat — hij is met
 * opzet read-only. Hem hier gebruiken leverde geen luide fout op maar precies het
 * tegenovergestelde: elke rij en elke statuswijziging wierp, `recordGeneration` ving dat
 * netjes op als "administratie niet bijgewerkt", en de route meldde succes. De documenten
 * stonden er, en in Monday was nooit iets te zien.
 */
export function createBriefingRecorder(
  client: MondayMutationClient,
  agendaBoardId: string
): BriefingRecorder {
  return {
    async setBrie(itemId, status) {
      /**
       * `change_simple_column_value` met de labeltekst, niet met een index.
       *
       * De indexen op `Brie` zijn historisch en lopen niet netjes door (0, 1, 2, 3, 5), dus
       * een getal in de code zou vastliggen aan een volgorde die ITG in hun eigen bord kan
       * wijzigen. De tekst is wat zij zien en wat het procesdeck noemt.
       */
      await client.mutate(SET_STATUS, {
        board: agendaBoardId,
        item: itemId,
        column: BRIEFING_AGENDA_COLUMNS.brie,
        value: status,
      });
    },

    async addRow(row) {
      const values = {
        [BRIEFINGS_COLUMNS.training]: { item_ids: [Number(row.trainingItemId)] },
        [BRIEFINGS_COLUMNS.ontvanger]: row.ontvanger,
        [BRIEFINGS_COLUMNS.rol]: { label: ROL_LABEL[row.role] },
        /**
         * `text` is wat er in de cel staat; zonder toont Monday een kale, onleesbare URL.
         * De bestandsnaam is precies wat iemand verwacht te zien staan.
         */
        [BRIEFINGS_COLUMNS.bestandslink]: { url: row.url, text: row.filename },
        [BRIEFINGS_COLUMNS.gegenereerd]: { date: row.gegenereerdOp },
      };
      const data = await client.mutate<{ create_item: { id: string } }>(
        CREATE_ITEM,
        {
          board: BRIEFINGS_BOARD,
          group: BRIEFINGS_GROUP,
          name: row.filename,
          // `column_values` is een JSON-scalar: Monday verwacht een string, geen object.
          values: JSON.stringify(values),
        },
        /**
         * Gesleuteld op de bestandslink, want die is uniek en onveranderlijk.
         *
         * De transportlaag probeert een netwerkfout of een 5xx opnieuw. Committeert Monday
         * de rij en gaat het antwoord verloren, dan levert die herkansing zonder sleutel een
         * tweede rij op voor hetzelfde document. Monday onderdrukt een herhaling van dezelfde
         * mutatie 30 minuten, en dat is precies lang genoeg voor een herkansing.
         *
         * De URL en niet de bestandsnaam: een `(v2)` is een ánder document met een eigen rij,
         * en die twee moeten uit elkaar te houden zijn. De naam alleen zou bovendien botsen
         * met een tweede generatie op een andere dag.
         */
        { idempotencyKey: `briefing-row:${row.trainingItemId}:${row.url}` }
      );
      return data.create_item.id;
    },
  };
}

/** De enige groep op het Briefings-bord. */
const BRIEFINGS_GROUP = 'topics';

export interface RecordInput {
  readonly trainingItemId: string;
  readonly rows: readonly Omit<BriefingRow, 'trainingItemId' | 'gegenereerdOp'>[];
  /** True als er velden ontbraken die als zichtbare regel in het document landen. */
  readonly incompleet: boolean;
  readonly vandaag: string;
}

/**
 * De administratie van één generatie, ook als die maar half gelukt is.
 *
 * Apart van de route en puur, want dit is precies de plek waar het misging: over de
 * GERENDERDE documenten lopen in plaats van over de geschreven leverde bij een deelresultaat
 * een `undefined` op — een 500 waarbij níets werd vastgelegd, en dus exact de wees die het
 * deelresultaat hoort te voorkomen.
 */
export function recordInputFor(input: {
  readonly trainingItemId: string;
  /** Wat er gerenderd is: draagt de naam en de rol per ontvanger. */
  readonly documents: readonly {
    trainerNaam: string;
    role: RecipientRole;
    open: readonly string[];
  }[];
  /** Wat er écht in SharePoint staat. Bij een deelresultaat korter dan `documents`. */
  readonly written: readonly { file: { name: string; webUrl: string } }[];
  readonly vandaag: string;
}): RecordInput {
  const deels = input.written.length < input.documents.length;
  return {
    trainingItemId: input.trainingItemId,
    rows: input.written.map((bestand, index) => ({
      filename: bestand.file.name,
      ontvanger: input.documents[index].trainerNaam,
      role: input.documents[index].role,
      url: bestand.file.webUrl,
    })),
    /**
     * Ontbrekende velden landen als zichtbare regel in het document; dat is wat "Begonnen,
     * niet klaar" betekent in ITG's eigen procesbeschrijving. Een halve generatie valt onder
     * dezelfde noemer: `Staat klaar` boven een training waarvan de helft van de briefings
     * ontbreekt is domweg onwaar.
     */
    incompleet: deels || input.documents.some((doc) => doc.open.length > 0),
    vandaag: input.vandaag,
  };
}

export interface RecordOutcome {
  readonly brie: BrieStatus;
  /** Wat er niet is vastgelegd. Leeg is goed nieuws. */
  readonly problemen: readonly string[];
}

/**
 * De administratie bijwerken, en nooit de generatie laten mislukken.
 *
 * Op het moment dat dit draait staan de documenten al in de klantmap. Een mislukte
 * statuskolom of een rij die niet is aangemaakt is vervelend en moet gemeld worden, maar het
 * werk is gedaan — een `throw` hier zou de adviseur vertellen dat het genereren is mislukt
 * terwijl de trainer zijn briefing gewoon kan openen, en hij zou het opnieuw proberen en er
 * een `(v2)` bij krijgen.
 */
export async function recordGeneration(
  recorder: BriefingRecorder,
  input: RecordInput
): Promise<RecordOutcome> {
  const problemen: string[] = [];

  /**
   * Eén rij per document, ook bij opnieuw genereren.
   *
   * Een `(v2)` is een ánder bestand, met een eigen link. De oude rij bijwerken zou verbergen
   * dat er een eerdere versie ligt — precies het feit dat het versienummer bewaart.
   */
  for (const rij of input.rows) {
    try {
      await recorder.addRow({
        ...rij,
        trainingItemId: input.trainingItemId,
        gegenereerdOp: input.vandaag,
      });
    } catch (error) {
      problemen.push(
        `Rij voor ${rij.ontvanger} niet aangemaakt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const brie: BrieStatus = input.incompleet ? 'Begonnen, niet klaar' : 'Staat klaar';
  try {
    await recorder.setBrie(input.trainingItemId, brie);
  } catch (error) {
    problemen.push(
      `Brie niet op "${brie}" gezet: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { brie, problemen };
}
