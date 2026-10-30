/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';

/**
 * Maakt onze kolommen op het Opportunitybord: de achtergrondinformatie, het concept programma
 * en de extra info voor de briefing (lange tekst), en de link naar het inventarisatieformulier. Een kolom die er al staat blijft
 * ongemoeid, dus opnieuw draaien maakt alleen wat er nog mist.
 *
 * Het concept programma en de extra info kwamen er 12-Oct-2026 bij (Dirkje): de
 * accountmanager vult de bullets en de extra info al in de Opportunityfase in, en de extra
 * info hoeft dan niet meer als update met "In briefing" ervoor.
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
 * maakt alleen de kolommen die nog ontbreken.
 */

const EXIT_FAILURE = 1;

/**
 * **Vastgepinde** kolom-ids, geen door Monday verzonnen ids.
 *
 * De lezer zoekt op id en niet op titel, juist zodat ITG de kolom mag hernoemen zonder dat de
 * briefing leegloopt. Monday laat een onbekend kolom-id stilzwijgend weg in plaats van te
 * foutmelden, dus een id dat wij niet kennen is niet te onderscheiden van een leeg veld.
 *
 * `long_text` en niet `text`, omdat de tekst uit meerdere alinea's bestaat — Dirkje zegt dat
 * expliciet. Een `text`-kolom kapt af en slikt regelafbrekingen.
 */
const KOLOMMEN: ReadonlyArray<{
  readonly id: string;
  readonly titel: string;
  readonly type: 'long_text' | 'link' | 'doc';
}> = [
  /**
   * Een document, omdat de lange-tekstkolom `itg_achtergrond` die hier eerst stond bij 2.000
   * tekens afkapte. Die is op 29-Oct-2026 overgezet en wordt niet meer gelezen of aangemaakt.
   */
  {
    id: OPPORTUNITY_COLUMNS.achtergrond,
    titel: 'Achtergrondinformatie (document)',
    type: 'doc',
  },
  {
    id: OPPORTUNITY_COLUMNS.conceptProgramma,
    titel: 'Concept programma (briefing)',
    type: 'long_text',
  },
  { id: OPPORTUNITY_COLUMNS.extraInfo, titel: 'Extra info voor briefing', type: 'long_text' },
  /** Gevuld door ons (`lib/inventarisatie`), niet door ITG. */
  { id: OPPORTUNITY_COLUMNS.inventarisatie, titel: 'Inventarisatieformulier', type: 'link' },
];

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

  const data = await read.query<{
    boards: Array<{ id: string; name: string; columns: BoardColumn[] }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type } } }', {
    b: [OPPORTUNITY_BOARD],
  });
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

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  for (const kolom of KOLOMMEN) {
    const bestaand = board.columns.find((c) => c.id === kolom.id);
    if (bestaand !== undefined) {
      if (bestaand.type !== kolom.type) {
        throw new Error(
          `Kolom ${kolom.id} bestaat al maar is type '${bestaand.type}', verwacht '${kolom.type}'. ` +
            'Handmatig corrigeren; dit script overschrijft geen bestaande kolom.'
        );
      }
      console.log(`  bestaat al: ${kolom.id} ("${bestaand.title}")`);
      continue;
    }

    console.log(
      `${apply ? '  APPLY ' : '  would '}create column ${kolom.id} "${kolom.titel}" (${kolom.type})`
    );
    if (!apply) {
      continue;
    }
    const created = await write.mutate<{ create_column: { id: string } }>(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String!) {
         create_column(board_id: $board, title: $title, column_type: $type, id: $id) { id }
       }`,
      { board: OPPORTUNITY_BOARD, title: kolom.titel, type: kolom.type, id: kolom.id },
      // De kolom-id in de sleutel, zodat een herhaalde run dezelfde bedoeling hergebruikt in
      // plaats van een tweede kolom te maken binnen Monday's venster van 30 minuten.
      { idempotencyKey: `opportunity-achtergrond:${OPPORTUNITY_BOARD}:${kolom.id}` }
    );

    const gemaakt = created.create_column?.id;
    if (gemaakt !== kolom.id) {
      throw new Error(
        `Monday gaf kolom-id '${gemaakt}' terug in plaats van '${kolom.id}'. De id is niet ` +
          'vastgepind; de lezer zou hem niet vinden. Controleer het bord voordat je verder gaat.'
      );
    }
    console.log(`  aangemaakt: ${gemaakt}`);
  }
  if (!apply) {
    console.log('\n  Droogloop. Voer uit met --apply om het echt aan te maken.');
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
