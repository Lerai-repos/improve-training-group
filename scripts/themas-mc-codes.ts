/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION, THEMAS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

/**
 * De acht kolommen voor de Monday Challenge-productcodes op het Themabord.
 *
 * Eén kolom per label, want de code verschilt per thema ÉN per label: "Verbindend
 * communiceren" is IT-58, maar JE-60, TT-27, SST-45 en CC-64. Er zit geen gedeelde nummering
 * in, dus afleiden kan niet — dat is gemeten en door ITG bevestigd.
 *
 * Vorm gekozen door Dirkje (27-Aug-2026): kolommen op de themaregel, niet een apart bord.
 *
 * Dit script maakt ALLEEN de kolommen. Het vullen is een tweede besluit en een tweede run,
 * net als bij `themas-conceptinhoud.ts`: een kolom die bestaat maar leeg is, is zichtbaar
 * onaf; een kolom die half gevuld is met een verkeerde kaart is dat niet.
 *
 *   pnpm exec tsx scripts/themas-mc-codes.ts            (droogloop)
 *   pnpm exec tsx scripts/themas-mc-codes.ts --apply
 */

const COLUMN_TYPE = 'text';

/** Labelcode → kolom-id en titel. De volgorde is die van ITG's eigen werkblad. */
const KOLOMMEN: readonly { label: string; id: string; titel: string }[] = [
  { label: 'IT', id: 'itg_mc_it', titel: 'MC-code IT' },
  { label: 'JE', id: 'itg_mc_je', titel: 'MC-code JE' },
  { label: 'TT', id: 'itg_mc_tt', titel: 'MC-code TT' },
  { label: 'SST', id: 'itg_mc_sst', titel: 'MC-code SST' },
  { label: 'FV', id: 'itg_mc_fv', titel: 'MC-code FV' },
  { label: 'WJ', id: 'itg_mc_wj', titel: 'MC-code WJ' },
  { label: 'CC', id: 'itg_mc_cc', titel: 'MC-code CC' },
  { label: 'CP', id: 'itg_mc_cp', titel: 'MC-code CP' },
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
  const data = await read.query<{ boards: { id: string; name: string; columns: BoardColumn[] }[] }>(
    `query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type } } }`,
    { b: [THEMAS_BOARD] }
  );
  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Themas-bord ${THEMAS_BOARD} niet gevonden of niet toegankelijk`);
  }
  console.log(`\nBord ${board.id} — ${board.name}  (${board.columns.length} kolommen)\n`);

  /**
   * Een bestaande kolom van het VERKEERDE type is een halt, geen waarschuwing.
   *
   * Doorgaan zou codes wegschrijven naar iets wat ze niet kan bewaren, en dat valt pas op
   * als een briefing een lege regel toont.
   */
  for (const kolom of KOLOMMEN) {
    const bestaand = board.columns.find((c) => c.id === kolom.id);
    if (bestaand !== undefined && bestaand.type !== COLUMN_TYPE) {
      throw new Error(
        `Kolom ${kolom.id} bestaat al maar is type '${bestaand.type}', verwacht '${COLUMN_TYPE}'.`
      );
    }
  }

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  let gemaakt = 0;

  for (const kolom of KOLOMMEN) {
    const bestaand = board.columns.find((c) => c.id === kolom.id);
    if (bestaand !== undefined) {
      console.log(`  bestaat al : ${kolom.id}  ("${bestaand.title}")`);
      continue;
    }
    console.log(`  ${apply ? 'APPLY  ' : 'would  '}create ${kolom.id}  "${kolom.titel}"  (${COLUMN_TYPE})`);
    if (!apply) {
      continue;
    }
    const created = await write.mutate<{ create_column: { id: string } }>(
      `mutation ($board: ID!, $title: String!, $id: String!, $type: ColumnType!) {
         create_column(board_id: $board, title: $title, column_type: $type, id: $id) { id }
       }`,
      { board: THEMAS_BOARD, title: kolom.titel, id: kolom.id, type: COLUMN_TYPE },
      /**
       * Het bord-id hoort in de sleutel.
       *
       * Monday onderdrukt dezelfde sleutel 30 minuten lang, en dit script kan tegen een
       * duplicaat-bord draaien; zonder het bord-id zou die tweede run het antwoord van de
       * eerste terugkrijgen en stilzwijgend niets doen.
       */
      { idempotencyKey: `themas-mc-codes:${THEMAS_BOARD}:${kolom.id}` }
    );
    if (created.create_column?.id !== kolom.id) {
      throw new Error(
        `Monday gaf kolom-id '${created.create_column?.id}' terug in plaats van '${kolom.id}'.`
      );
    }
    gemaakt += 1;
  }

  if (!apply) {
    console.log('\n  DROOGLOOP — er is niets gewijzigd. Draai met --apply om te maken.\n');
    return;
  }

  // Teruglezen, want "de mutatie gaf geen fout" is niet hetzelfde als "de kolom staat er".
  const na = await read.query<{ boards: { columns: BoardColumn[] }[] }>(
    `query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }`,
    { b: [THEMAS_BOARD] }
  );
  const nu = new Map((na.boards?.[0]?.columns ?? []).map((c) => [c.id, c]));
  const ontbreekt = KOLOMMEN.filter((k) => nu.get(k.id)?.type !== COLUMN_TYPE);
  console.log(`\n  ${gemaakt} kolom(men) aangemaakt.`);
  if (ontbreekt.length > 0) {
    throw new Error(`Na afloop ontbreken deze nog: ${ontbreekt.map((k) => k.id).join(', ')}`);
  }
  console.log('  Teruggelezen: alle acht kolommen staan er als text.\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
