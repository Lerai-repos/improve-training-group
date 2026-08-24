/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { agendaBoardId, AGENDA_2026_COLUMNS, MONDAY_API_VERSION, TRAINERS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { checkColumn, type ColumnVerdict } from '@lib/monday/provisioning';
import { BRIEFING_AGENDA_COLUMNS } from '@lib/briefing/columns';

/**
 * Maakt de kolom voor de co-trainers op het agendabord.
 *
 * ITG ging 21-Aug-2026 akkoord met deze vorm: de **bestaande** relatie
 * `Trainers contactgegevens` betekent voortaan de **leadtrainer**, en de co-trainers krijgen
 * een eigen kolom. Voordeel boven het omgekeerde: de 667 trainingen met één trainer hoeven
 * niet aangeraakt te worden, want die ene staat er al in en is per definitie de lead.
 *
 * Dit is bewust een **uitzondering** op de regel "niets nieuws op het agendabord" uit
 * `itg-briefing-design-decisions`. Reden: welk tekstblok iemand krijgt (Leadtrainer versus
 * Co-trainer, die tegengestelde dingen beweren over wie het klantcontact doet) én welke
 * Klantcontactmoment-regel hangen ervan af, en het staat vandaag nergens vast. Peter zet het
 * soms in een update, en Dirkje: *"dit gaat vaak niet goed."*
 *
 *   pnpm agenda:cotrainer            # droogloop
 *   pnpm agenda:cotrainer --apply
 *
 * Draait tegen het live bord van de klant, dus droogloop is de standaard.
 */

const EXIT_FAILURE = 1;

/** Vastgepinde kolom-id; de lezer zoekt op id zodat ITG mag hernoemen. */
const COLUMN_ID = 'itg_cotrainers';

const COLUMN_TITLE = 'Co-trainer(s)';

/**
 * Zelfde instellingen als `Trainers contactgegevens` (`board_relation_mkz4y7tb`), gemeten:
 * `{"allowCreateReflectionColumn":false,"boardIds":[1661151090]}`. Meerdere co-trainers moeten
 * kunnen, dus de relatie is niet beperkt tot één item.
 */
const COLUMN_DEFAULTS = JSON.stringify({
  allowCreateReflectionColumn: false,
  boardIds: [Number(TRAINERS_BOARD)],
});

interface BoardColumn {
  id: string;
  title: string;
  type: string;
  settings_str?: string | null;
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const boardId = agendaBoardId();
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  const data = await read.query<{ boards: Array<{ id: string; name: string; columns: BoardColumn[] }> }>(
    'query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type settings_str } } }',
    { b: [boardId] }
  );
  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Agendabord ${boardId} niet gevonden of niet toegankelijk`);
  }

  /**
   * Controleren dát dit het agendabord is, en niet alleen dát er een bord is. Een kolom op
   * het verkeerde bord valt niet op: hij staat er, leeg, en niemand merkt het.
   */
  const leadRelation = board.columns.find((c) => c.id === AGENDA_2026_COLUMNS.trainerRelation);
  if (leadRelation === undefined) {
    throw new Error(
      `Bord ${boardId} ("${board.name}") mist ${AGENDA_2026_COLUMNS.trainerRelation}; dit lijkt ` +
        'niet het agendabord te zijn. Gestopt zonder iets te wijzigen.'
    );
  }
  console.log(`\nBord ${board.id} — ${board.name}  (${board.columns.length} kolommen)\n`);
  console.log(`  de leadkolom is de bestaande relatie: ${leadRelation.id} "${leadRelation.title}"`);
  console.log(`     ${leadRelation.settings_str ?? ''}\n`);

  const existing = board.columns.find((c) => c.id === COLUMN_ID);
  if (existing !== undefined) {
    /**
     * Het type alleen is niet genoeg om "niets te doen" te mogen zeggen.
     *
     * Een handmatig aangemaakte of verschoven `board_relation` heeft exact het type dat we
     * verwachten en kan intussen naar eender welk bord wijzen. Die kolom valt niet op: hij
     * staat er, hij is leeg, en de co-trainers die erin horen te komen verdwijnen stil.
     */
    const verdict = checkColumn(
      { id: COLUMN_ID, type: 'board_relation', relationBoardIds: [TRAINERS_BOARD] },
      existing
    );
    if (verdict.kind !== 'ok') {
      throw new Error(
        `Kolom ${COLUMN_ID} bestaat al maar ${describeVerdict(verdict)}. Handmatig corrigeren; ` +
          'dit script overschrijft geen bestaande kolom.'
      );
    }
    console.log(`  kolom bestaat al: ${COLUMN_ID} ("${existing.title}")`);
    console.log(`     ${existing.settings_str ?? ''}`);
    console.log('  niets te doen.\n');
    return;
  }

  console.log(`${apply ? '  APPLY ' : '  would '}create column ${COLUMN_ID} "${COLUMN_TITLE}" (board_relation → Trainers ${TRAINERS_BOARD})`);
  console.log(`     defaults: ${COLUMN_DEFAULTS}\n`);
  if (!apply) {
    console.log('  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
    return;
  }

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const created = await write.mutate<{ create_column: { id: string } }>(
    `mutation ($board: ID!, $title: String!, $id: String!, $defaults: JSON) {
       create_column(
         board_id: $board, title: $title, column_type: board_relation, id: $id, defaults: $defaults
       ) { id }
     }`,
    { board: boardId, title: COLUMN_TITLE, id: COLUMN_ID, defaults: COLUMN_DEFAULTS },
    { idempotencyKey: `agenda-cotrainer:${boardId}:${COLUMN_ID}` }
  );

  const made = created.create_column?.id;
  if (made !== COLUMN_ID) {
    throw new Error(
      `Monday gaf kolom-id '${made}' terug in plaats van '${COLUMN_ID}'. De id is niet vastgepind; ` +
        'de lezer zou hem niet vinden. Controleer het bord voordat je verder gaat.'
    );
  }
  console.log(`  aangemaakt: ${made}\n`);
  console.log('  LET OP: de aanbevelingsengine en de evaluaties lezen nu alleen de leadkolom.');
  console.log('  Zodra ITG co-trainers gaat verplaatsen moeten die beide kolommen lezen, anders');
  console.log(`  verdwijnt een co-trainer stil uit zijn eigen scores. Zie ${BRIEFING_AGENDA_COLUMNS.trainerRelation}.\n`);
}

/** Waarom een bestaande kolom is afgekeurd, in de foutmelding. */
function describeVerdict(verdict: ColumnVerdict): string {
  switch (verdict.kind) {
    case 'wrong_type':
      return `is type '${verdict.found}', verwacht 'board_relation'`;
    case 'wrong_relation':
      return `wijst naar bord ${verdict.found.join(', ')} in plaats van naar Trainers (${TRAINERS_BOARD})`;
    case 'wrong_labels':
      return `mist de labels ${verdict.missing.join(', ')}`;
    case 'unreadable_settings':
      return 'de instellingen zijn niet te lezen, dus de bestemming is niet te controleren';
    case 'ok':
      return 'klopt';
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
