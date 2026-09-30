/* eslint-disable no-console */
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  briefingtekstenBoardId,
  readMerk,
  readTekstRijen,
  SECTIES,
  statusWijzigingen,
  synchroniseerStatussen,
  TEKST_COLUMN_SPECS,
  TEKST_COLUMNS,
  TEKST_GROEPEN,
  uitlegVoor,
} from '@lib/briefingteksten';
import { buildTekstenClients } from '@lib/briefingteksten/deps';
import { LABEL_CODES, labelsBoardId } from '@lib/labels';
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

/**
 * Maakt het bord Briefingteksten: elke tekst in de briefing, door ITG te bewerken.
 *
 *   pnpm briefingteksten:create             # droogloop
 *   pnpm briefingteksten:create --apply     # bord, kolommen, groepen en de 23 teksten
 *   pnpm briefingteksten:create --webhook   # NA de deploy: de Status-webhook aanmaken
 *   pnpm briefingteksten:create --keur      # Status en Melding één keer bijwerken
 *
 * De teksten komen uit `lib/briefingteksten/catalog.ts`: wat er op 30-Sep-2026 in de briefing
 * stond. Een item dat er al staat (herkend aan zijn Sleutel) wordt NOOIT overschreven — na de
 * eerste run is het bord van ITG.
 *
 * `--webhook` is een aparte stap omdat Monday bij het aanmaken meteen de route aanroept (de
 * challenge). Die route bestaat pas na de deploy, en die deploy heeft het bord-id nodig.
 */

const EXIT_FAILURE = 1;
const INTENT_PATH = join(process.cwd(), '.briefingteksten-create.json');

/** Zelfde werkruimte als de andere ITG-borden. */
const WORKSPACE_ID = '5308763';
const BOARD_KIND = 'private';
const BOARD_NAME = 'Briefingteksten';

const [EERSTE_GROEP] = TEKST_GROEPEN;

const BESCHRIJVING =
  'De teksten van de briefing. Pas Kop en Tekst aan; de briefing gebruikt altijd wat hier ' +
  'staat. Elke regel in Tekst is een alinea, een regel die begint met - is een opsomming, ' +
  'met -- een opsomming één niveau dieper. Tekst leeg = de sectie staat niet in de briefing. ' +
  'De volgorde in de briefing ligt vast. Status en Melding worden automatisch ingevuld. ' +
  'Sleutel niet aanpassen. Aangemaakt door `pnpm briefingteksten:create`.';

const OUR_COLUMN_IDS = TEKST_COLUMN_SPECS.map((c) => c.id);

type Clients = ReturnType<typeof buildTekstenClients>;
type Read = Clients['read'];
type Write = Clients['write'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const clients = buildTekstenClients();

  if (argv.includes('--webhook')) {
    await registreerWebhooks(clients, briefingtekstenBoardId());
    return;
  }
  if (argv.includes('--keur')) {
    const boardId = briefingtekstenBoardId();
    const gewijzigd = await synchroniseerStatussen(clients.read, clients.write, boardId);
    console.log(`\n  ${gewijzigd.length} item(s) bijgewerkt op bord ${boardId}`);
    for (const w of gewijzigd) {
      console.log(`    ${w.naam.padEnd(34)} ${w.status}${w.melding === '' ? '' : ` — ${w.melding}`}`);
    }
    return;
  }

  await inrichten(clients, argv.includes('--apply'));
}

async function inrichten({ read, write }: Clients, apply: boolean): Promise<void> {
  console.log(`\n${BOARD_NAME}-bord — ${apply ? 'APPLY' : 'droogloop'}\n`);

  const file = intentFile(INTENT_PATH);
  const intent: ProvisionIntent = file.read() ?? {
    runId: `briefingteksten-${Date.now()}`,
    startedAt: Date.now(),
    samples: { phase: 'uncaptured' },
  };
  let boardId = intent.boardId;
  const fingerprint = provisionFingerprint('briefingteksten', intent.runId);

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
            'versturen kan een TWEEDE bord opleveren.\n' +
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
          description: `${BESCHRIJVING} Niet weghalen: ${fingerprint}`,
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
    droogloop();
    return;
  }

  await assertBoardIdentity(read, boardId, {
    name: BOARD_NAME,
    workspaceId: WORKSPACE_ID,
    fingerprint,
  });

  await cleanupSamples(read, write, boardId, intent, file, {
    ourColumnIds: OUR_COLUMN_IDS,
    groupTitle: EERSTE_GROEP,
    log: (line) => console.log(line),
  });

  await ensureColumns(read, write, boardId, intent);
  const groepen = await ensureGroups(read, write, boardId, intent);
  await ensureItems(read, write, boardId, intent, groepen);
  await verify(read, boardId);

  console.log(
    `\n  Zet dit id in lib/briefingteksten/board.ts:  BRIEFINGTEKSTEN_PRODUCTION_BOARD = '${boardId}'` +
      '\n  Na de deploy: pnpm briefingteksten:create --webhook\n'
  );
}

function droogloop(): void {
  for (const spec of TEKST_COLUMN_SPECS) {
    console.log(`  would create column ${spec.id.padEnd(14)} "${spec.title}" (${spec.type})`);
  }
  for (const groep of TEKST_GROEPEN) {
    console.log(`  would ensure group  "${groep}"`);
    for (const sectie of SECTIES.filter((s) => s.groep === groep)) {
      console.log(`    would create item ${sectie.sleutel.padEnd(28)} "${sectie.naam}"`);
    }
  }
  console.log(`\n  ${SECTIES.length} teksten. Droogloop; voer uit met --apply.\n`);
}

async function ensureColumns(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent
): Promise<void> {
  const board = (await read.getSchema([boardId]))[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden.`);
  }
  const existing = new Map(board.columns.map((c) => [c.id, c]));

  for (const spec of TEKST_COLUMN_SPECS) {
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
      { board: boardId, title: spec.title, type: spec.type, id: spec.id, defaults: spec.defaults },
      { idempotencyKey: keyFor(intent, `column:${spec.id}`) }
    );
    console.log(`  aangemaakt: ${made.create_column.id.padEnd(14)} "${spec.title}" (${spec.type})`);
  }
}

/**
 * De acht groepen, in documentvolgorde, elk ná de vorige.
 *
 * Een bestaande groep wordt NIET verplaatst: zodra ITG het bord gebruikt is de indeling hun
 * keuze, en de code kijkt er toch niet naar.
 */
async function ensureGroups(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent
): Promise<ReadonlyMap<string, string>> {
  const board = (await read.getSchema([boardId]))[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden.`);
  }
  const perTitel = new Map(board.groups.map((g) => [g.title, g.id]));
  if (!perTitel.has(EERSTE_GROEP)) {
    throw new Error(
      `Bord ${boardId} heeft geen groep "${EERSTE_GROEP}". Het opruimen hoort de standaardgroep ` +
        'zo te hebben hernoemd; controleer het bord met de hand.'
    );
  }

  let vorige = perTitel.get(EERSTE_GROEP) ?? '';
  for (const titel of TEKST_GROEPEN.slice(1)) {
    const bestaand = perTitel.get(titel);
    if (bestaand !== undefined) {
      console.log(`  groep bestaat al: "${titel}"`);
      vorige = bestaand;
      continue;
    }
    const made = await write.mutate<{ create_group: { id: string } }>(
      `mutation ($board: ID!, $name: String!, $anchor: String!) {
         create_group(board_id: $board, group_name: $name, relative_to: $anchor,
                      position_relative_method: after_at) { id }
       }`,
      { board: boardId, name: titel, anchor: vorige },
      { idempotencyKey: keyFor(intent, `group:${titel}`) }
    );
    console.log(`  groep aangemaakt: "${titel}" (${made.create_group.id})`);
    perTitel.set(titel, made.create_group.id);
    vorige = made.create_group.id;
  }
  return perTitel;
}

/** Elke sectie waarvan de Sleutel nog nergens op het bord staat, met de begintekst. */
async function ensureItems(
  read: Read,
  write: Write,
  boardId: string,
  intent: ProvisionIntent,
  groepen: ReadonlyMap<string, string>
): Promise<void> {
  const aanwezig = new Set((await readTekstRijen(read, boardId)).map((r) => r.sleutel));

  for (const sectie of SECTIES) {
    if (aanwezig.has(sectie.sleutel)) {
      console.log(`  tekst staat er al: ${sectie.sleutel}`);
      continue;
    }
    const groep = groepen.get(sectie.groep);
    if (groep === undefined) {
      throw new Error(`Geen groep "${sectie.groep}" op bord ${boardId}.`);
    }
    await write.mutate(
      `mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) { id }
       }`,
      {
        board: boardId,
        group: groep,
        name: sectie.naam,
        // Alles in één create, zodat een item nooit half gevuld zichtbaar is.
        values: JSON.stringify({
          [TEKST_COLUMNS.kop]: sectie.kop,
          [TEKST_COLUMNS.tekst]: { text: sectie.tekst },
          [TEKST_COLUMNS.status]: { label: 'OK' },
          [TEKST_COLUMNS.melding]: '',
          [TEKST_COLUMNS.uitleg]: { text: uitlegVoor(sectie) },
          [TEKST_COLUMNS.sleutel]: sectie.sleutel,
        }),
      },
      { idempotencyKey: keyFor(intent, `item:${sectie.sleutel}`) }
    );
    console.log(`  tekst aangemaakt: ${sectie.sleutel.padEnd(28)} "${sectie.naam}"`);
  }
}

/**
 * Teruglezen met de lezer die de briefing gebruikt, en keuren zoals de webhook keurt.
 *
 * Een geslaagde mutatie bewijst niet dat Monday de tekst ongeschonden bewaarde. Deze keuring
 * vergelijkt wat er teruggelezen wordt met de catalogus, en controleert dat elk label een
 * `{merk}` en `{term}` heeft.
 */
async function verify(read: Read, boardId: string): Promise<void> {
  const rijen = await readTekstRijen(read, boardId);
  console.log(`\n  Teruggelezen: ${rijen.length} items`);

  const perSleutel = new Map(rijen.map((r) => [r.sleutel, r]));
  const afwijkend = SECTIES.filter((s) => {
    const rij = perSleutel.get(s.sleutel);
    return rij === undefined || rij.kop.trim() !== s.kop || rij.tekst.trim() !== s.tekst;
  });
  for (const s of afwijkend) {
    console.log(`  AFWIJKEND of ontbrekend: ${s.sleutel} (bewerkt door ITG, of niet goed bewaard)`);
  }
  const statussen = statusWijzigingen(rijen);
  console.log(
    `  Status klopt bij ${rijen.length - statussen.length} van ${rijen.length}` +
      (statussen.length === 0 ? '' : ' — draai --keur om bij te werken')
  );

  for (const code of LABEL_CODES) {
    const { merk, term } = await readMerk(read, labelsBoardId(), code);
    console.log(`  ${code.padEnd(4)} {merk} = ${merk.padEnd(22)} {term} = ${term.toLowerCase()}`);
  }
}

/**
 * De twee webhooks: een kolomwijziging en een nieuw item.
 *
 * Het bord is van ons alleen, dus elke webhook die er staat is van ons: staat het event er al,
 * dan wordt hij niet nog eens aangemaakt.
 */
async function registreerWebhooks({ read, write }: Clients, boardId: string): Promise<void> {
  const base = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  const token = (process.env.MONDAY_WEBHOOK_TOKEN ?? '').trim();
  if (base === '' || token === '') {
    throw new Error('PUBLIC_BASE_URL en MONDAY_WEBHOOK_TOKEN zijn nodig voor --webhook.');
  }
  const url = `${base}/api/webhooks/monday/briefingteksten?token=${token}`;

  const data = await read.query<{ webhooks?: Array<{ id: string; event: string }> | null }>(
    'query ($b: ID!) { webhooks(board_id: $b) { id event } }',
    { b: boardId }
  );
  const bestaand = new Set((data.webhooks ?? []).map((w) => w.event));

  for (const event of ['change_column_value', 'create_item']) {
    if (bestaand.has(event)) {
      console.log(`  webhook bestaat al: ${event}`);
      continue;
    }
    const made = await write.mutate<{ create_webhook: { id: string } }>(
      `mutation ($b: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook(board_id: $b, url: $url, event: $event) { id }
       }`,
      { b: boardId, url, event },
      { idempotencyKey: `briefingteksten-webhook:${boardId}:${event}` }
    );
    // Nooit de URL printen: het geheim zit erin.
    console.log(`  webhook aangemaakt: ${event} (${made.create_webhook.id})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
