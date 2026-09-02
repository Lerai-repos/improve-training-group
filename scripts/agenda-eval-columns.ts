/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { agendaBoardId, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { checkColumn } from '@lib/monday/provisioning';
import { EVAL_COLUMNS, IE_STATUS_COLUMN, IE_STATUS_ONVINDBAAR } from '@lib/report/record';

/**
 * Maakt de twee getalkolommen waar het evaluatieresultaat in komt te staan.
 *
 * `04-evaluatierapportage.md` beschrijft ze als bestaand — *"Op het Monday agenda-item:
 * eindcijfer, aantal respondenten"* — maar op het live bord staan ze niet. Gemeten
 * 2-Sep-2026: van de 72 kolommen zijn er vijf getalkolommen (Trainers nummer, Acteuraantal,
 * O, Uren, Exacte duur) en geen daarvan draagt een cijfer of een aantal respondenten. Het
 * document beschrijft dus de bedoelde eindtoestand, niet de huidige.
 *
 * De statuskolom hoeft NIET aangemaakt te worden: `IE. Trainer` bestaat al en heeft
 * `Onvindbaar` al als label. Dit script controleert dat alleen.
 *
 * Dit is bewust een tweede uitzondering op "niets nieuws op het agendabord", net als de
 * co-trainerkolom: de waarden horen per training zichtbaar te zijn op de plek waar ITG
 * werkt, en een apart bord zou een extra klik zijn voor twee getallen.
 *
 *   pnpm agenda:evalkolommen            # droogloop
 *   pnpm agenda:evalkolommen --apply
 *
 * Draait tegen het live bord van de klant, dus droogloop is de standaard.
 */

const EXIT_FAILURE = 1;

interface Spec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

const COLUMNS: readonly Spec[] = [
  {
    id: EVAL_COLUMNS.eindcijfer,
    title: 'Gem. eindcijfer',
    description:
      'Gemiddeld eindcijfer uit de individuele evaluaties. Automatisch gevuld; niet met de hand aanpassen.',
  },
  {
    id: EVAL_COLUMNS.respondenten,
    title: 'Respondenten',
    description:
      'Aantal deelnemers dat de evaluatie invulde. Automatisch gevuld; niet met de hand aanpassen.',
  },
];

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
  const board = agendaBoardId();
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  console.log(`\nAgendabord ${board} — ${apply ? 'APPLY' : 'droogloop'}\n`);

  const meta = await read.query<{ boards: Array<{ name: string; columns: BoardColumn[] }> }>(
    'query ($b: [ID!]) { boards(ids: $b) { name columns { id title type settings_str } } }',
    { b: [board] }
  );
  const target = meta.boards?.[0];
  if (target === undefined) {
    throw new Error(`Bord ${board} niet gevonden.`);
  }
  console.log(`  bord: ${target.name}`);

  /**
   * Eerst de statuskolom controleren, en weigeren als hij niet klopt.
   *
   * Zonder `Onvindbaar` kan de geen-data-flow zijn signaal niet zetten, en dat is precies de
   * functie die ITG in februari vroeg. Twee getalkolommen aanmaken terwijl dat stuk niet kan
   * werken zou een halve oplevering zijn die er heel afgemaakt uitziet.
   */
  const status = target.columns.find((c) => c.id === IE_STATUS_COLUMN);
  if (status === undefined) {
    throw new Error(
      `De statuskolom ${IE_STATUS_COLUMN} (IE. Trainer) staat niet op dit bord. Zonder die ` +
        'kolom kan het "geen data"-signaal nergens heen.'
    );
  }
  const verdict = checkColumn(
    { id: IE_STATUS_COLUMN, type: 'status', statusLabels: [IE_STATUS_ONVINDBAAR] },
    status
  );
  if (verdict.kind !== 'ok') {
    throw new Error(
      `De statuskolom "${status.title}" mist het label ${IE_STATUS_ONVINDBAAR}. Voeg dat in ` +
        'Monday toe; dit script raakt bestaande statuslabels niet aan.'
    );
  }
  console.log(`  statuskolom "${status.title}" heeft ${IE_STATUS_ONVINDBAAR}  ✓`);

  const existing = new Map(target.columns.map((c) => [c.id, c]));
  let created = 0;

  for (const spec of COLUMNS) {
    const already = existing.get(spec.id);
    if (already !== undefined) {
      if (already.type !== 'numbers') {
        throw new Error(
          `Kolom ${spec.id} bestaat al als '${already.type}', verwacht 'numbers'. Handmatig ` +
            'corrigeren; dit script overschrijft geen bestaande kolom.'
        );
      }
      console.log(`  kolom bestaat al: ${spec.id} ("${already.title}")`);
      continue;
    }

    console.log(
      `  ${apply ? 'APPLY ' : 'would '}create ${spec.id.padEnd(18)} "${spec.title}" (numbers)`
    );
    if (!apply) {
      continue;
    }
    const made = await write.mutate<{ create_column: { id: string } }>(
      `mutation ($board: ID!, $title: String!, $id: String!, $description: String!) {
         create_column(board_id: $board, title: $title, column_type: numbers, id: $id,
                       description: $description) { id }
       }`,
      { board, title: spec.title, id: spec.id, description: spec.description },
      // Het bord-id zit in de sleutel: Monday onthoudt hem 30 minuten, en dit script kan
      // tegen zowel productie als een kopie draaien.
      { idempotencyKey: `evalcols:${board}:${spec.id}` }
    );
    console.log(`     aangemaakt: ${made.create_column.id}`);
    created += 1;
  }

  if (!apply) {
    console.log('\n  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
    return;
  }
  console.log(`\n  Klaar. ${created} kolom(men) aangemaakt.\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
