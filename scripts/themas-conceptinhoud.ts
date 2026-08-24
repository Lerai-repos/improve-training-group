/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION, THEMAS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { THEMAS_COLUMNS } from '@lib/briefing/columns';
import { ORGANISATIE_TOKEN } from '@lib/briefing/concept';

/**
 * Zet de 85 thema-skeletten van ITG op het Themas-bord.
 *
 * De bron is `ITG - Training skeletten 2024.docx`, uitgelezen door
 * `tools/skeletten/extract.py`. De koppen daarin zijn de lánge productnamen ("Neuro
 * Linguïstisch Programmeren") terwijl het bord korte namen voert ("NLP"), dus er ligt een
 * kaart met de hand in `tools/skeletten/thema-map.json`. 35 vallen vanzelf samen, 41 staan
 * in de kaart, 4 hebben geen thema op het bord en 6 zijn een openstaande vraag aan ITG.
 *
 *   pnpm themas:conceptinhoud                        # droogloop
 *   pnpm themas:conceptinhoud --apply --alleen-kolom  # alleen de kolom aanmaken
 *   pnpm themas:conceptinhoud --apply                 # kolom plus de 76 skeletten
 *
 * Draait tegen het live bord van de klant, dus droogloop is de standaard. Overschrijft
 * nooit een thema waar al tekst in staat; zie `--overschrijf`.
 */

const EXIT_FAILURE = 1;
const COLUMN_ID = THEMAS_COLUMNS.conceptInhoud;
const COLUMN_TITLE = 'Concept inhoud';
const COLUMN_TYPE = 'long_text';

/** Precies het aantal koppen in het bronbestand; wijkt het af, dan is de kaart verouderd. */
const EXPECTED_SKELETONS = 85;

interface Skeleton {
  readonly skelet: string;
  readonly regels: readonly string[];
}

interface ThemaMap {
  readonly kaart: Readonly<Record<string, string>>;
  readonly geenThema: Readonly<Record<string, string>>;
  readonly openVraag: Readonly<Record<string, string>>;
}

interface BoardColumn {
  id: string;
  title: string;
  type: string;
}

interface BoardItem {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
}

const readJson = <T,>(path: string): T => JSON.parse(readFileSync(path, 'utf-8')) as T;

/**
 * De itemnaam waar een skelet naartoe moet, of `null` als het er geen heeft.
 *
 * Bewust géén normalisatie (kleine letters, streepjes weg). `Kantoor DNA` en `Kantoor-DNA`
 * schelen één streepje en staan daarom gewoon in de kaart: normaliseren zou ook
 * `Klantgericht werken` aan `Oplossingsgericht werken` kunnen knopen, en dan staat het
 * programma van een ánder thema in een briefing bij de klant.
 */
function target(skelet: string, map: ThemaMap, boardNames: ReadonlySet<string>): string | null {
  if (map.kaart[skelet] !== undefined) {
    return map.kaart[skelet];
  }
  return boardNames.has(skelet) ? skelet : null;
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const overwrite = process.argv.includes('--overschrijf');
  /**
   * De kolom aanmaken en hem vullen zijn twee besluiten.
   *
   * De briefinglezer toetst het bordschema en weigert te genereren zolang
   * `itg_conceptinhoud` niet bestaat — terecht, want een ontbrekende kolom is niet te
   * onderscheiden van 85 lege thema's. Maar de **inhoud** wacht op zes keuzes van ITG, en
   * die twee aan elkaar knopen zou de hele briefingketen blokkeren op een vraag die er niets
   * mee te maken heeft. Met deze vlag komt de lege kolom er nu, en de tekst later.
   */
  const columnOnly = process.argv.includes('--alleen-kolom');

  const skeletons = readJson<Skeleton[]>('tools/skeletten/skeletten.json');
  const map = readJson<ThemaMap>('tools/skeletten/thema-map.json');
  if (skeletons.length !== EXPECTED_SKELETONS) {
    throw new Error(
      `${skeletons.length} skeletten in skeletten.json, verwacht ${EXPECTED_SKELETONS}. ` +
        'Draai tools/skeletten/extract.py opnieuw en loop thema-map.json na.'
    );
  }

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const data = await read.query<{
    boards: Array<{
      id: string;
      name: string;
      columns: BoardColumn[];
      items_page: { items: BoardItem[] };
    }>;
  }>(
    `query ($b: [ID!], $cols: [String!]) {
       boards(ids: $b) {
         id name
         columns { id title type }
         items_page(limit: 500) {
           items { id name column_values(ids: $cols) { id text value } }
         }
       }
     }`,
    { b: [THEMAS_BOARD], cols: [COLUMN_ID] }
  );
  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Themas-bord ${THEMAS_BOARD} niet gevonden of niet toegankelijk`);
  }
  const items = board.items_page.items;
  console.log(`\nBord ${board.id} — ${board.name}  (${items.length} thema's)\n`);

  const existing = board.columns.find((c) => c.id === COLUMN_ID);
  if (existing !== undefined && existing.type !== COLUMN_TYPE) {
    throw new Error(
      `Kolom ${COLUMN_ID} bestaat al maar is type '${existing.type}', verwacht '${COLUMN_TYPE}'.`
    );
  }
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  if (existing === undefined) {
    console.log(`${apply ? '  APPLY ' : '  would '}create column ${COLUMN_ID} "${COLUMN_TITLE}" (${COLUMN_TYPE})`);
    if (apply) {
      const created = await write.mutate<{ create_column: { id: string } }>(
        `mutation ($board: ID!, $title: String!, $id: String!, $type: ColumnType!) {
           create_column(board_id: $board, title: $title, column_type: $type, id: $id) { id }
         }`,
        { board: THEMAS_BOARD, title: COLUMN_TITLE, id: COLUMN_ID, type: COLUMN_TYPE },
        { idempotencyKey: `themas-conceptinhoud:${THEMAS_BOARD}:column` }
      );
      if (created.create_column?.id !== COLUMN_ID) {
        throw new Error(
          `Monday gaf kolom-id '${created.create_column?.id}' terug in plaats van '${COLUMN_ID}'.`
        );
      }
    }
  } else {
    console.log(`  kolom bestaat al: ${COLUMN_ID} ("${existing.title}")`);
  }

  if (columnOnly) {
    console.log(
      `\n  --alleen-kolom: de kolom is klaar, de 85 skeletten zijn NIET geschreven.\n` +
        '  Draai zonder die vlag zodra ITG de zes openstaande keuzes heeft beantwoord.\n'
    );
    return;
  }

  /**
   * Op naam groeperen en niet op het eerste treffer-item: `Focus en aandacht` staat twee
   * keer op het bord en `Teamcoaching` ook. Alleen de eerste vullen laat de helft van de
   * trainingen met dat thema leeg achter, en leeg ziet er hetzelfde uit als "nooit gevuld".
   */
  const byName = new Map<string, BoardItem[]>();
  for (const item of items) {
    const group = byName.get(item.name) ?? [];
    group.push(item);
    byName.set(item.name, group);
  }
  const boardNames = new Set(byName.keys());

  const plan: Array<{ item: BoardItem; skelet: string; tekst: string }> = [];
  const skipped: string[] = [];
  const filled: string[] = [];
  for (const skeleton of skeletons) {
    if (map.geenThema[skeleton.skelet] !== undefined) {
      continue;
    }
    if (map.openVraag[skeleton.skelet] !== undefined) {
      skipped.push(`${skeleton.skelet} — open vraag: ${map.openVraag[skeleton.skelet]}`);
      continue;
    }
    const name = target(skeleton.skelet, map, boardNames);
    if (name === null) {
      throw new Error(
        `Skelet "${skeleton.skelet}" staat niet in thema-map.json en heeft geen gelijknamig ` +
          'item op het bord. Vul de kaart aan; raden is hier geen optie.'
      );
    }
    const targets = byName.get(name);
    if (targets === undefined) {
      throw new Error(
        `thema-map.json wijst "${skeleton.skelet}" naar "${name}", maar dat item staat niet ` +
          'op het bord. Is het hernoemd of verwijderd?'
      );
    }
    const tekst = skeleton.regels.join('\n');
    for (const item of targets) {
      const current = (item.column_values.find((c) => c.id === COLUMN_ID)?.text ?? '').trim();
      if (current !== '' && !overwrite) {
        filled.push(`${name} (${item.id})`);
        continue;
      }
      plan.push({ item, skelet: skeleton.skelet, tekst });
    }
  }

  const withToken = plan.filter((p) => p.tekst.includes(ORGANISATIE_TOKEN)).length;
  console.log(`\n  te schrijven: ${plan.length} items, waarvan ${withToken} met ${ORGANISATIE_TOKEN}`);
  for (const step of plan) {
    const lines = step.tekst.split('\n').length;
    const via = step.skelet === step.item.name ? '' : `  (skelet: ${step.skelet})`;
    console.log(`    ${apply ? 'APPLY ' : 'would '}${step.item.name} — ${lines} regels${via}`);
  }
  if (filled.length > 0) {
    console.log(`\n  overgeslagen, staat al tekst in (${filled.length}): ${filled.join(', ')}`);
    console.log('    gebruik --overschrijf om ze toch te vervangen.');
  }
  if (skipped.length > 0) {
    console.log(`\n  NIET geschreven, ITG moet eerst kiezen (${skipped.length}):`);
    for (const line of skipped) {
      console.log(`    - ${line}`);
    }
  }
  const noSkeleton = [...boardNames].filter(
    (n) => !plan.some((p) => p.item.name === n) && !filled.some((f) => f.startsWith(`${n} (`))
  );
  console.log(`\n  thema's op het bord zonder skelet: ${noSkeleton.length}`);

  if (!apply) {
    console.log('\n  Droogloop. Voer uit met --apply om het echt te schrijven.\n');
    return;
  }

  let done = 0;
  for (const step of plan) {
    await write.mutate<{ change_column_value: { id: string } }>(
      `mutation ($board: ID!, $item: ID!, $col: String!, $val: JSON!) {
         change_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) { id }
       }`,
      {
        board: THEMAS_BOARD,
        item: step.item.id,
        col: COLUMN_ID,
        val: JSON.stringify({ text: step.tekst }),
      },
      /**
       * De **inhoud** hoort in de sleutel, niet alleen het item.
       *
       * Monday onderdrukt een herhaling van dezelfde sleutel 30 minuten lang. Wordt een
       * skelet gecorrigeerd en `--overschrijf` binnen dat venster opnieuw gedraaid, dan
       * geeft Monday het antwoord van de vórige schrijfactie terug, schrijft niets, en meldt
       * dit script "bijgewerkt". De correctie is dan stilzwijgend verdwenen.
       *
       * Met de hash erin blijft een échte herhaling (zelfde tekst) stabiel — dat is precies
       * waar de sleutel voor is — en krijgt gewijzigde tekst een nieuwe sleutel.
       */
      {
        idempotencyKey:
          `themas-conceptinhoud:${THEMAS_BOARD}:${step.item.id}:` +
          createHash('sha256').update(step.tekst).digest('hex').slice(0, 16),
      }
    );
    done += 1;
  }
  console.log(`\n  ${done} thema's bijgewerkt.\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
