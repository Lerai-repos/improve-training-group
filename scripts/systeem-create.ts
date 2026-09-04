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
import { SIGNAL_COLUMN_SPECS, SIGNAL_GROUP_ORDER, SIGNAL_GROUPS } from '@lib/signals';
import { signalGroups } from '@lib/signals/deps';
import { readSignals } from '@lib/signals/read';

/**
 * Maakt het Systeem-bord: waar de dagelijkse controle zijn meldingen neerzet.
 *
 *   pnpm systeem:create            # droogloop
 *   pnpm systeem:create --apply
 *
 * Er worden GEEN rijen aangemaakt. Het bord hoort leeg te beginnen: elke rij erop is straks
 * iets dat de controle heeft gevonden, en een voorbeeldrij zou als melding meelezen.
 */

const EXIT_FAILURE = 1;
const INTENT_PATH = join(process.cwd(), '.systeem-create.json');

/** Zelfde werkruimte als de andere ITG-borden. */
const WORKSPACE_ID = '5308763';
const BOARD_KIND = 'private';
const BOARD_NAME = 'Systeem';

const OUR_COLUMN_IDS = SIGNAL_COLUMN_SPECS.map((c) => c.id);

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  console.log(`\n${BOARD_NAME}-bord — ${apply ? 'APPLY' : 'droogloop'}\n`);

  const file = intentFile(INTENT_PATH);
  const intent: ProvisionIntent = file.read() ?? {
    runId: `systeem-${Date.now()}`,
    startedAt: Date.now(),
    samples: { phase: 'uncaptured' },
  };
  let boardId = intent.boardId;
  const fingerprint = provisionFingerprint('systeem', intent.runId);

  if (boardId === undefined) {
    console.log(
      `  ${apply ? 'APPLY ' : 'would '}create ${BOARD_KIND} board "${BOARD_NAME}" ` +
        `in workspace ${WORKSPACE_ID}`
    );
    if (apply) {
      file.write(intent);

      const verdict = unresolvedCreateVerdict(intent.startedAt, Date.now());
      if (verdict.kind === 'refuse') {
        throw new Error(
          `Er staat een onafgeronde create van ${verdict.ageMinutes} minuten geleden in ` +
            `${INTENT_PATH}, en Monday's idempotency-venster (30 min) is verlopen. Opnieuw ` +
            'versturen kan een TWEEDE Systeem-bord opleveren.\n' +
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
          description:
            "Signaleringen van de dagelijkse controle — labels en thema's die nog niet, of " +
            'niet volledig, zijn ingesteld. Aangemaakt door `pnpm systeem:create`. ' +
            `Niet weghalen: ${fingerprint}`,
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

  await assertBoardIdentity(read, boardId, {
    name: BOARD_NAME,
    workspaceId: WORKSPACE_ID,
    fingerprint,
  });

  await cleanupSamples(read, write, boardId, intent, file, {
    ourColumnIds: OUR_COLUMN_IDS,
    groupTitle: SIGNAL_GROUPS.open,
    log: (line) => console.log(line),
  });

  await ensureColumns(read, write, boardId, intent);
  await ensureGroups(read, write, boardId, intent);
  await verify(read, boardId);

  console.log(`\n  Zet dit id in lib/signals/board.ts:  SYSTEEM_PRODUCTION_BOARD = '${boardId}'\n`);
}

function dryRun(): void {
  for (const spec of SIGNAL_COLUMN_SPECS) {
    const extra = spec.defaults === null ? '' : `  defaults: ${spec.defaults}`;
    console.log(
      `  would create column ${spec.id.padEnd(18)} "${spec.title}" (${spec.type})${extra}`
    );
  }
  for (const title of SIGNAL_GROUP_ORDER) {
    console.log(`  would ensure group  "${title}"`);
  }
  console.log('\n  Geen rijen: het bord begint leeg.');
  console.log('\n  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
}

type Read = ReturnType<typeof createMondayGraphQLClient>;
type Write = ReturnType<typeof createMondayMutationClient>;

async function ensureColumns(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent
): Promise<void> {
  const meta = await read.getSchema([boardId]);
  const board = meta[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden.`);
  }
  const existing = new Map(board.columns.map((c) => [c.id, c]));

  for (const spec of SIGNAL_COLUMN_SPECS) {
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
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String!, $defaults: JSON) {
         create_column(board_id: $board, title: $title, column_type: $type, id: $id,
                       defaults: $defaults) { id }
       }`,
      {
        board: boardId,
        title: spec.title,
        type: spec.type,
        id: spec.id,
        defaults: spec.defaults,
      },
      { idempotencyKey: keyFor(intent, `column:${spec.id}`) }
    );
    console.log(`  aangemaakt: ${made.create_column.id.padEnd(18)} "${spec.title}" (${spec.type})`);
  }
}

/**
 * De drie groepen, in bordvolgorde.
 *
 * `cleanupSamples` heeft de standaardgroep al hernoemd naar "Meldingen"; die is dus het anker
 * waar de andere twee omheen komen te staan. Positioneren met `relative_to` en niet gewoon
 * aanmaken: een `create_group` zonder positie plakt de groep bovenaan, en dan staat
 * "Afgehandeld" boven "Meldingen" — precies de leesvolgorde die deze indeling moet vermijden.
 *
 * Een bestaande groep wordt NIET verplaatst. Zodra ITG het bord gebruikt is de volgorde hun
 * keuze, en een inrichtingsscript dat elke run de indeling terugzet is een script dat niemand
 * meer durft te draaien.
 */
async function ensureGroups(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent
): Promise<void> {
  const meta = await read.getSchema([boardId]);
  const board = meta[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden.`);
  }
  const byTitle = new Map(board.groups.map((g) => [g.title, g.id]));

  const anchor = byTitle.get(SIGNAL_GROUPS.open);
  if (anchor === undefined) {
    throw new Error(
      `Bord ${boardId} heeft geen groep "${SIGNAL_GROUPS.open}". Het opruimen hoort die te ` +
        'hebben hernoemd; controleer het bord met de hand.'
    );
  }

  const wanted: ReadonlyArray<{ title: string; method: 'before_at' | 'after_at' }> = [
    { title: SIGNAL_GROUPS.samenvatting, method: 'before_at' },
    { title: SIGNAL_GROUPS.afgehandeld, method: 'after_at' },
  ];

  for (const group of wanted) {
    if (byTitle.has(group.title)) {
      console.log(`  groep bestaat al: "${group.title}"`);
      continue;
    }
    const made = await write.mutate<{ create_group: { id: string } }>(
      `mutation ($board: ID!, $name: String!, $anchor: String!, $method: PositionRelative!) {
         create_group(board_id: $board, group_name: $name, relative_to: $anchor,
                      position_relative_method: $method) { id }
       }`,
      { board: boardId, name: group.title, anchor, method: group.method },
      { idempotencyKey: keyFor(intent, `group:${group.title}`) }
    );
    console.log(`  groep aangemaakt: "${group.title}" (${made.create_group.id})`);
  }
}

/**
 * Teruglezen met de lezer die de controle zelf gebruikt.
 *
 * Tellen hoeveel mutaties 200 gaven bewijst alleen dat de verzoeken aankwamen. Wat we willen
 * weten is of `readSignals` dit bord kan lezen — want daar hangt de hele afvinkmechaniek aan.
 */
async function verify(read: Read, boardId: string): Promise<void> {
  const signals = await readSignals(read, boardId);
  console.log(`\n  Teruggelezen: ${signals.length} meldingen`);

  // Dit is wat de controle straks nodig heeft; het opzoeken hier maakt een hernoemde of
  // ontbrekende groep zichtbaar op het moment dat je er nog bij staat.
  const groups = await signalGroups(read, boardId);
  console.log(
    `  Groepen: samenvatting=${groups.samenvatting} open=${groups.open} ` +
      `afgehandeld=${groups.afgehandeld}`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
