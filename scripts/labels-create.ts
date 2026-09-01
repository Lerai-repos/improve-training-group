/* eslint-disable no-console */
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { checkColumn } from '@lib/monday/provisioning';
import {
  assertBoardIdentity,
  captureSamples,
  cleanupSamples,
  intentFile,
  keyFor,
  provisionFingerprint,
  unresolvedCreateVerdict,
  type ProvisionIntent,
} from '@lib/monday/provision-shell';
import {
  LABEL_COLUMN_SPECS,
  LABEL_GAPS,
  LABEL_SEED,
  describeProblem,
  seedColumnValues,
  validateCatalog,
} from '@lib/labels';
import { readLabels } from '@lib/labels/read';

/**
 * Maakt het Labels-bord: negen merken, één rij per merk.
 *
 * Vervangt Airtable's tabel `Label Configuratie`. Het bord bepaalt hoe een label ERUITZIET —
 * kleur, naam, rapportterm, formulieren, afbeeldingen. WELKE labels bestaan blijft in code
 * (`LABEL_CODES`), want elk label heeft ook een briefingsjabloon in de repo: een tiende rij
 * hier levert geen tiende label op maar een briefing die niet gegenereerd kan worden.
 *
 *   pnpm labels:create            # droogloop
 *   pnpm labels:create --apply
 *
 * Het bord-id gaat direct na aanmaken naar `.labels-create.json`. Alles daarna is te
 * repareren; het id kwijtraken niet.
 */

const EXIT_FAILURE = 1;
const INTENT_PATH = join(process.cwd(), '.labels-create.json');

/** Zelfde werkruimte als de andere ITG-borden. Privé: het bevat merkmateriaal, geen publiek goed. */
const WORKSPACE_ID = '5308763';
const BOARD_KIND = 'private';
const BOARD_NAME = 'Labels';
const GROUP_TITLE = 'Labels';

const OUR_COLUMN_IDS = LABEL_COLUMN_SPECS.map((c) => c.id);

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  /**
   * De seed keuren vóórdat er een bord bestaat.
   *
   * Een bord aanmaken en er dan achter komen dat de startwaarden niet deugen laat een half
   * ingericht bord achter dat een mens moet opruimen. Dit is een goedkope controle die dat
   * hele scenario wegneemt.
   */
  const seedProblems = validateCatalog(LABEL_SEED);
  if (seedProblems.length > 0) {
    throw new Error(
      `De startwaarden deugen niet:\n  ${seedProblems.map(describeProblem).join('\n  ')}`
    );
  }

  console.log(`\n${BOARD_NAME}-bord — ${apply ? 'APPLY' : 'droogloop'}\n`);

  const file = intentFile(INTENT_PATH);
  const intent: ProvisionIntent = file.read() ?? {
    runId: `labels-${Date.now()}`,
    startedAt: Date.now(),
    samples: { phase: 'uncaptured' },
  };
  let boardId = intent.boardId;

  /**
   * Bindt dit bord aan DEZE poging, en gaat mee in de bordomschrijving.
   *
   * Zie `provisionFingerprint`: naam plus werkruimte is geen identiteit, want Monday staat
   * twee borden "Labels" naast elkaar toe.
   */
  const fingerprint = provisionFingerprint('labels', intent.runId);

  if (boardId === undefined) {
    console.log(
      `  ${apply ? 'APPLY ' : 'would '}create ${BOARD_KIND} board "${BOARD_NAME}" ` +
        `in workspace ${WORKSPACE_ID}`
    );
    if (apply) {
      // Sleutel vastleggen VÓÓR de eerste mutatie — zie `intentFile`.
      file.write(intent);

      const verdict = unresolvedCreateVerdict(intent.startedAt, Date.now());
      if (verdict.kind === 'refuse') {
        throw new Error(
          `Er staat een onafgeronde create van ${verdict.ageMinutes} minuten geleden in ` +
            `${INTENT_PATH}, en Monday's idempotency-venster (30 min) is verlopen. Opnieuw ` +
            'versturen kan een TWEEDE Labels-bord opleveren.\n' +
            'Kijk in de werkruimte of het bord al bestaat:\n' +
            `  - zo ja:  zet "boardId" in ${INTENT_PATH} en draai opnieuw\n` +
            `  - zo nee: verwijder ${INTENT_PATH} en draai opnieuw.`
        );
      }

      const made = await write.mutate<{ create_board: { id: string } }>(
        `mutation ($name: String!, $workspace: ID!, $description: String!) {
           create_board(board_name: $name, board_kind: ${BOARD_KIND}, workspace_id: $workspace,
                        description: $description) { id }
         }`,
        {
          name: BOARD_NAME,
          workspace: WORKSPACE_ID,
          // Het merkteken hoort in de OMSCHRIJVING, niet in de naam: de naam is wat ITG leest
          // en desgewenst hernoemt, de omschrijving raakt niemand aan.
          description:
            'Labelconfiguratie voor de rapportmotor — negen merken, één rij per merk. ' +
            `Aangemaakt door \`pnpm labels:create\`. Niet weghalen: ${fingerprint}`,
        },
        { idempotencyKey: keyFor(intent, 'create_board') }
      );
      boardId = made.create_board.id;
      intent.boardId = boardId;
      file.write(intent);
      console.log(`  bord aangemaakt: ${boardId}  (opgeslagen in ${INTENT_PATH})`);

      await captureSamples(read, boardId, intent, file);
    }
  } else {
    console.log(`  bord bestaat al uit een eerdere run: ${boardId}`);
  }

  if (!apply || boardId === undefined) {
    dryRun();
    return;
  }

  /**
   * Vóór er ook maar iets verdwijnt: is dit het bord dat we denken?
   *
   * Vooral voor het herstelpad, waar een mens `boardId` met de hand in het intentiebestand
   * zet — zie `assertBoardIdentity`. Een bord dat we net zelf hebben aangemaakt komt hier
   * gratis doorheen, dus het kost niets om het altijd te controleren.
   */
  await assertBoardIdentity(read, boardId, {
    name: BOARD_NAME,
    workspaceId: WORKSPACE_ID,
    fingerprint,
  });

  // Opruimen strikt vóór de eerste kolom: dat is de invariant waar `sampleCleanupPlan` op steunt.
  await cleanupSamples(read, write, boardId, intent, file, {
    ourColumnIds: OUR_COLUMN_IDS,
    groupTitle: GROUP_TITLE,
    log: (line) => console.log(line),
  });

  const groupId = await ensureColumns(read, write, boardId, intent);
  await ensureRows(read, write, boardId, intent, groupId);
  await verify(read, boardId);

  console.log(`\n  Zet dit id in lib/labels/board.ts:  LABELS_PRODUCTION_BOARD = '${boardId}'\n`);
  reportGaps();
}

function dryRun(): void {
  for (const spec of LABEL_COLUMN_SPECS) {
    console.log(`  would create column ${spec.id.padEnd(22)} "${spec.title}" (${spec.type})`);
  }
  for (const label of LABEL_SEED) {
    const filled = Object.keys(seedColumnValues(label)).length;
    const naam = `"${label.volledigeNaam}"`;
    console.log(
      `  would create item ${label.code.padEnd(4)} ${naam.padEnd(24)} ` +
        `${label.kleur}  ${filled}/7 velden gevuld`
    );
  }
  reportGaps();
  console.log('\n  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
}

function reportGaps(): void {
  console.log('\n  Bewust leeg (gemeten 1-Sep-2026), wacht op ITG:');
  for (const [field, reason] of Object.entries(LABEL_GAPS)) {
    console.log(`     ${field.padEnd(30)} ${reason}`);
  }
  console.log('\n  Nog te doen met de hand: Logo, Voorblad en Achterblad per label uploaden.');
}

type Read = ReturnType<typeof createMondayGraphQLClient>;
type Write = ReturnType<typeof createMondayMutationClient>;

/** Maakt de ontbrekende kolommen aan en geeft de groep terug waar de rijen in horen. */
async function ensureColumns(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent
): Promise<string> {
  const meta = await read.query<{
    boards: Array<{
      groups: Array<{ id: string; title: string }>;
      columns: Array<{ id: string; type: string; settings_str?: string | null }>;
    }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { groups { id title } columns { id type settings_str } } }', {
    b: [boardId],
  });
  const board = meta.boards?.[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden.`);
  }
  const existing = new Map(board.columns.map((c) => [c.id, c]));

  for (const spec of LABEL_COLUMN_SPECS) {
    const already = existing.get(spec.id);
    if (already !== undefined) {
      const verdict = checkColumn({ id: spec.id, type: spec.type }, already);
      if (verdict.kind !== 'ok') {
        throw new Error(
          `Kolom ${spec.id} bestaat al als '${already.type}', verwacht '${spec.type}'. ` +
            'Handmatig corrigeren; dit script overschrijft geen bestaande kolom.'
        );
      }
      console.log(`  kolom bestaat al: ${spec.id}`);
      continue;
    }
    const made = await write.mutate<{ create_column: { id: string } }>(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String!) {
         create_column(board_id: $board, title: $title, column_type: $type, id: $id) { id }
       }`,
      { board: boardId, title: spec.title, type: spec.type, id: spec.id },
      { idempotencyKey: keyFor(intent, `column:${spec.id}`) }
    );
    console.log(`  aangemaakt: ${made.create_column.id.padEnd(22)} "${spec.title}" (${spec.type})`);
  }

  /**
   * Bij voorkeur de groep die het opruimen heeft hernoemd, en pas anders de eerste.
   *
   * `groups[0]` alleen is willekeurig zodra iemand een tweede groep aanmaakt — dan belanden
   * nieuwe rijen in wat er die dag toevallig bovenaan staat, en dat valt niemand op.
   */
  const group = board.groups.find((g) => g.title === GROUP_TITLE) ?? board.groups[0];
  if (group === undefined) {
    throw new Error(`Bord ${boardId} heeft geen enkele groep om rijen in te zetten.`);
  }
  return group.id;
}

/**
 * Maakt de ontbrekende rijen aan — en raakt een bestaande rij NIET aan.
 *
 * Zodra het bord in gebruik is, is elke bestaande waarde iemands bewuste keuze. Een herstelrun
 * die de startwaarden er opnieuw overheen zet zou een aangepaste kleur of een gecorrigeerde
 * naam terugdraaien, en dat zou niemand merken.
 */
async function ensureRows(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent,
  groupId: string
): Promise<void> {
  const data = await read.query<{
    boards: Array<{ items_page: { items: Array<{ id: string; name: string }> } }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 100) { items { id name } } } }', {
    b: [boardId],
  });
  const present = new Set(
    (data.boards?.[0]?.items_page?.items ?? []).map((i) => i.name.trim())
  );

  for (const label of LABEL_SEED) {
    if (present.has(label.code)) {
      console.log(`  rij bestaat al: ${label.code}`);
      continue;
    }
    await write.mutate(
      `mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) { id }
       }`,
      {
        board: boardId,
        group: groupId,
        name: label.code,
        // Waarden reizen MET de create mee, zodat een rij nooit half gevuld zichtbaar is.
        values: JSON.stringify(seedColumnValues(label)),
      },
      { idempotencyKey: keyFor(intent, `item:${label.code}`) }
    );
    console.log(`  rij aangemaakt: ${label.code.padEnd(4)} ${label.volledigeNaam}`);
  }
}

/**
 * Lees het bord terug DOOR DE LEZER DIE HET RAPPORT STRAKS GEBRUIKT.
 *
 * Tellen hoeveel mutaties 200 gaven bewijst alleen dat elk verzoek is aangekomen. Het ziet
 * geen dubbele rij, geen kolom die als het verkeerde type is ontstaan en geen waarde die niet
 * parst — en dat is precies wat `readLabels` weigert. Het contract is "de rapportmotor kan dit
 * bord lezen", dus dat is wat er gecontroleerd wordt.
 */
async function verify(read: Read, boardId: string): Promise<void> {
  const labels = await readLabels(read, boardId);
  console.log(`\n  Teruggelezen: ${labels.size} labels`);
  for (const [code, record] of labels) {
    const assets = [
      record.logo === null ? '' : 'logo',
      record.voorblad === null ? '' : 'voorblad',
      record.achterblad === null ? '' : 'achterblad',
    ]
      .filter((s) => s !== '')
      .join(', ');
    console.log(
      `     ${code.padEnd(4)} ${record.volledigeNaam.padEnd(22)} ${record.kleur}  ` +
        `${assets === '' ? 'geen afbeeldingen' : assets}`
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
