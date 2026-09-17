/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { liveAgendaBoards, loadAgendaBoards } from '@lib/evaluations';
import { boardFromArgv } from '@lib/monday/board-arg';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { BRIEFING_AGENDA_COLUMNS } from '@lib/briefing/columns';

/**
 * Maakt `Huisw. opdr.` op het agendabord: een exacte kopie van `Voorb. opdr.`.
 *
 * Dirkje en Tim, 17-Sep-2026: de briefing leest huiswerk, voorbereidende opdracht en cyclus
 * voortaan van het agendabord in plaats van uit vinkjes in de tab. Voor de voorbereidende
 * opdracht bestaat de kolom al; voor huiswerk niet. Deze kolom krijgt dezelfde labels en
 * kleuren, maar via de API is een label-id altijd het kleurnummer. De lezer gaat op die ids
 * (`HUISWERK_WEL` in `lib/briefing/columns.ts`), dus het script controleert ze na.
 *
 * Aangemaakt op Agenda 2026 op 17-Sep-2026.
 *
 *   pnpm agenda:huiswerk                      # droogloop, alle actieve agendaborden
 *   pnpm agenda:huiswerk --apply
 *   pnpm agenda:huiswerk --board <id>         # alleen dat bord
 *
 * **Standaard elk actief agendabord**, zoals `loadAgendaBoards` ze vindt. De briefing weigert
 * een bord zonder deze kolom, dus een jaargang die later gedeeld wordt (2027) moet hem ook
 * krijgen, met dezelfde id. De dagelijkse controle meldt een bord waar hij ontbreekt
 * (`briefing-niet-aangesloten`); dan is dit script opnieuw draaien genoeg.
 *
 * Draait tegen het live bord van de klant, dus droogloop is de standaard.
 */

const EXIT_FAILURE = 1;

const COLUMN_ID = BRIEFING_AGENDA_COLUMNS.huiswerk;
const BRON_ID = BRIEFING_AGENDA_COLUMNS.voorbereidend;
const COLUMN_TITLE = 'Huisw. opdr.';
const COLUMN_DESCRIPTION = 'Huiswerkopdracht?';

/**
 * Index → label en kleur, gespiegeld aan `Voorb. opdr.` (gemeten 17-Sep-2026).
 *
 * Eén verschil: Monday's API staat bij het aanmaken hooguit 30 tekens per label toe, dus
 * "Geen huiswerkopdracht (deze sessie)" (35) wordt "Geen huiswerk (deze sessie)". In Monday
 * zelf mag het daarna langer; de lezer gaat op index, dus hernoemen breekt niets. Het grijze
 * standaardlabel (index 5) is via de API niet te zetten; een lege cel leest als nee.
 */
const LABELS = [
  { index: 0, label: 'Wel huiswerkopdracht', color: 'egg_yolk' },
  { index: 1, label: 'Staat klaar', color: 'dark_orange' },
  { index: 2, label: 'Geen huiswerk (deze sessie)', color: 'grass_green' },
  { index: 3, label: 'Verzonden', color: 'done_green', is_done: true },
] as const;

/** Het label-id dat Monday per label teruggeeft (= het kleurnummer), gemeten na het aanmaken. */
const VERWACHTE_IDS: Readonly<Record<string, string>> = {
  '9': 'Wel huiswerkopdracht',
  '19': 'Staat klaar',
  '6': 'Geen huiswerk (deze sessie)',
  '1': 'Verzonden',
};

interface BoardColumn {
  id: string;
  title: string;
  type: string;
  settings_str?: string | null;
}

/** De labels van een statuskolom per index, of null als de instellingen niet te lezen zijn. */
function labelsVan(settings: string | null | undefined): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(settings ?? '');
    if (typeof parsed !== 'object' || parsed === null || !('labels' in parsed)) {
      return null;
    }
    const labels: unknown = parsed.labels;
    if (typeof labels !== 'object' || labels === null) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === 'string')
    );
  } catch {
    return null;
  }
}

/** Welke label-ids afwijken van `VERWACHTE_IDS`. Leeg betekent: klopt. */
function afwijkingen(gevonden: Record<string, string>): string[] {
  return Object.entries(VERWACHTE_IDS)
    .filter(([id, label]) => gevonden[id] !== label)
    .map(([id, label]) => `${id}: verwacht "${label}", staat "${gevonden[id] ?? '—'}"`);
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  const gekozen = boardFromArgv(argv);
  const boardIds =
    gekozen === null
      ? liveAgendaBoards(await loadAgendaBoards(read)).map((b) => b.boardId)
      : [gekozen];
  console.log(`\nAgendaborden: ${boardIds.join(', ')}`);

  /** Elk bord apart: één bord dat faalt mag de rest niet tegenhouden, maar wel de exitcode. */
  const fouten: string[] = [];
  for (const boardId of boardIds) {
    try {
      await provision(token, read, boardId, apply);
    } catch (error: unknown) {
      const melding = error instanceof Error ? error.message : String(error);
      console.error(`  bord ${boardId}: ${melding}\n`);
      fouten.push(boardId);
    }
  }
  if (fouten.length > 0) {
    throw new Error(`Niet gelukt op: ${fouten.join(', ')}`);
  }
}

type ReadClient = ReturnType<typeof createMondayGraphQLClient>;

async function provision(
  token: string,
  read: ReadClient,
  boardId: string,
  apply: boolean
): Promise<void> {
  const lees = async (): Promise<{ name: string; columns: BoardColumn[] }> => {
    const data = await read.query<{ boards: Array<{ name: string; columns: BoardColumn[] }> }>(
      'query ($b: [ID!]) { boards(ids: $b) { name columns { id title type settings_str } } }',
      { b: [boardId] }
    );
    const board = data.boards?.[0];
    if (board === undefined) {
      throw new Error(`Bord ${boardId} niet gevonden of niet toegankelijk`);
    }
    return board;
  };

  const board = await lees();
  /** Dat dit een agendabord is, en niet alleen dát er een bord is. */
  const bron = board.columns.find((c) => c.id === BRON_ID);
  if (bron === undefined || bron.type !== 'status') {
    throw new Error(
      `Bord ${boardId} ("${board.name}") mist de statuskolom ${BRON_ID} (Voorb. opdr.); dit lijkt ` +
        'niet het agendabord te zijn. Gestopt zonder iets te wijzigen.'
    );
  }
  console.log(`\nBord ${boardId} — ${board.name}`);
  console.log(
    `  bron: ${BRON_ID} "${bron.title}"  ${JSON.stringify(labelsVan(bron.settings_str))}\n`
  );

  const bestaand = board.columns.find((c) => c.id === COLUMN_ID);
  if (bestaand !== undefined) {
    const labels = labelsVan(bestaand.settings_str);
    const fout =
      bestaand.type !== 'status'
        ? [`type is ${bestaand.type}`]
        : labels === null
          ? ['labels onleesbaar']
          : afwijkingen(labels);
    if (fout.length > 0) {
      throw new Error(`Kolom ${COLUMN_ID} bestaat al maar klopt niet:\n  ${fout.join('\n  ')}`);
    }
    console.log(`  kolom bestaat al en klopt: ${COLUMN_ID} "${bestaand.title}". Niets te doen.\n`);
    return;
  }

  const defaults = { labels: LABELS };
  console.log(`${apply ? '  APPLY ' : '  would '}create ${COLUMN_ID} "${COLUMN_TITLE}" (status)`);
  console.log(`     labels: ${JSON.stringify(LABELS)}\n`);
  if (!apply) {
    console.log('  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
    return;
  }

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const created = await write.mutate<{ create_status_column: { id: string } }>(
    `mutation ($board: ID!, $title: String!, $id: String!, $description: String,
               $defaults: CreateStatusColumnSettingsInput) {
       create_status_column(
         board_id: $board, title: $title, description: $description, id: $id, defaults: $defaults
       ) { id }
     }`,
    {
      board: boardId,
      title: COLUMN_TITLE,
      description: COLUMN_DESCRIPTION,
      id: COLUMN_ID,
      defaults,
    },
    { idempotencyKey: `agenda-huiswerk:${boardId}:${COLUMN_ID}` }
  );
  if (created.create_status_column?.id !== COLUMN_ID) {
    throw new Error(
      `Monday gaf kolom-id '${created.create_status_column?.id}' terug in plaats van '${COLUMN_ID}'. ` +
        'Controleer het bord voordat je verder gaat.'
    );
  }

  /** Nameten: de lezer gaat op index, dus een label op een andere plek leest stil verkeerd. */
  const na = (await lees()).columns.find((c) => c.id === COLUMN_ID);
  const labels = labelsVan(na?.settings_str);
  const fout = labels === null ? ['labels onleesbaar'] : afwijkingen(labels);
  if (fout.length > 0) {
    throw new Error(`Aangemaakt, maar de labels kloppen niet:\n  ${fout.join('\n  ')}`);
  }
  console.log(`  aangemaakt en nagemeten: ${COLUMN_ID}  ${na?.settings_str ?? ''}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
