/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';

/**
 * Maakt de kolom voor de achtergrondinformatie op het Opportunitybord.
 *
 * Dirkje, in `docs/correspondence/correspondence_august.md`:
 *
 * > *"Monday-veld voor achtergrondinfo: ik begreep dat jullie deze zouden aanmaken … Denk dan
 * > in het opportunitybord een lang tekstveld. We gebruiken wel altijd meerdere alinea's."*
 *
 * Dit is dus een openstaande actie aan ónze kant, niet aan die van ITG. De tekst heet bij hen
 * ook wel "de aanleidingtekst" en komt in de briefing onder het kopje Achtergrondinformatie.
 *
 *   pnpm opportunity:achtergrond            # dry run — laat zien wat het zou doen
 *   pnpm opportunity:achtergrond --apply
 *
 * Draait tegen het live bord van de klant. Daarom: droogloop als standaard, en `--apply`
 * verandert precies één ding.
 */

const EXIT_FAILURE = 1;

/**
 * Een **vastgepinde** kolom-id, geen door Monday verzonnen id.
 *
 * De lezer zoekt op id en niet op titel, juist zodat ITG de kolom mag hernoemen zonder dat de
 * briefing leegloopt. Monday laat een onbekend kolom-id stilzwijgend weg in plaats van te
 * foutmelden, dus een id dat wij niet kennen is niet te onderscheiden van een leeg veld.
 */
const COLUMN_ID = OPPORTUNITY_COLUMNS.achtergrond;

/** Wat ITG in de kolomkop ziet. Gelijk aan het kopje in de briefing. */
const COLUMN_TITLE = 'Achtergrondinformatie';

/**
 * `long_text` en niet `text`, omdat de tekst uit meerdere alinea's bestaat — Dirkje zegt dat
 * expliciet. Een `text`-kolom kapt af en slikt regelafbrekingen.
 */
const COLUMN_TYPE = 'long_text';

interface BoardColumn {
  id: string;
  title: string;
  type: string;
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  const data = await read.query<{ boards: Array<{ id: string; name: string; columns: BoardColumn[] }> }>(
    'query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type } } }',
    { b: [OPPORTUNITY_BOARD] }
  );
  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Opportunitybord ${OPPORTUNITY_BOARD} niet gevonden of niet toegankelijk`);
  }

  /**
   * Controleren dát het het juiste bord is, en niet alleen dát er een bord is.
   *
   * Een kolom aanmaken op het verkeerde bord van de klant is niet iets wat opvalt: hij staat
   * er gewoon, leeg, en niemand merkt het tot de briefing leeg blijft.
   */
  const heeftContactRelatie = board.columns.some((c) => c.id === OPPORTUNITY_COLUMNS.contact);
  if (!heeftContactRelatie) {
    throw new Error(
      `Bord ${OPPORTUNITY_BOARD} ("${board.name}") mist de kolom ${OPPORTUNITY_COLUMNS.contact}; ` +
        'dit lijkt niet het Opportunitybord te zijn. Gestopt zonder iets te wijzigen.'
    );
  }
  console.log(`\nBord ${board.id} — ${board.name}  (${board.columns.length} kolommen)\n`);

  const bestaand = board.columns.find((c) => c.id === COLUMN_ID);
  if (bestaand !== undefined) {
    if (bestaand.type !== COLUMN_TYPE) {
      throw new Error(
        `Kolom ${COLUMN_ID} bestaat al maar is type '${bestaand.type}', verwacht '${COLUMN_TYPE}'. ` +
          'Handmatig corrigeren; dit script overschrijft geen bestaande kolom.'
      );
    }
    console.log(`  kolom bestaat al: ${COLUMN_ID} ("${bestaand.title}", ${bestaand.type})`);
    console.log('  niets te doen.\n');
    return;
  }

  /**
   * Er staan al twee kolommen "Beschrijving" op dit bord. Die laten we met rust — de ene bevat
   * de aanvraag van de klant zelf, in de ik-vorm — maar het is wel het vermelden waard, zodat
   * niemand denkt dat we een derde bijna-duplicaat per ongeluk toevoegen.
   */
  const lijkend = board.columns.filter(
    (c) => c.type === 'long_text' || /beschrijving|achtergrond|aanleiding/i.test(c.title)
  );
  if (lijkend.length > 0) {
    console.log('  bestaande tekstkolommen die erop lijken (blijven ongemoeid):');
    for (const c of lijkend) {
      console.log(`     ${c.id.padEnd(24)} ${c.title}  (${c.type})`);
    }
    console.log();
  }

  console.log(`${apply ? '  APPLY ' : '  would '}create column ${COLUMN_ID} "${COLUMN_TITLE}" (${COLUMN_TYPE})\n`);
  if (!apply) {
    console.log('  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
    return;
  }

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const created = await write.mutate<{ create_column: { id: string } }>(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String!) {
       create_column(board_id: $board, title: $title, column_type: $type, id: $id) { id }
     }`,
    { board: OPPORTUNITY_BOARD, title: COLUMN_TITLE, type: COLUMN_TYPE, id: COLUMN_ID },
    // De kolom-id in de sleutel, zodat een herhaalde run dezelfde bedoeling hergebruikt in
    // plaats van een tweede kolom te maken binnen Monday's venster van 30 minuten.
    { idempotencyKey: `opportunity-achtergrond:${OPPORTUNITY_BOARD}:${COLUMN_ID}` }
  );

  const gemaakt = created.create_column?.id;
  if (gemaakt !== COLUMN_ID) {
    throw new Error(
      `Monday gaf kolom-id '${gemaakt}' terug in plaats van '${COLUMN_ID}'. De id is niet ` +
        'vastgepind; de lezer zou hem niet vinden. Controleer het bord voordat je verder gaat.'
    );
  }
  console.log(`  aangemaakt: ${gemaakt}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
