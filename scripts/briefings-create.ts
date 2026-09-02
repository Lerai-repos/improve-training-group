/* eslint-disable no-console */
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  agendaBoardId,
  AGENDA_2026_COLUMNS,
  AGENDA_2026_PRODUCTION_BOARD,
  MONDAY_API_VERSION,
} from '@lib/monday/board-config';
import { agendaOverrideVerdict, checkColumn, type ColumnVerdict } from '@lib/monday/provisioning';
import {
  assertBoardIdentity,
  captureSamples,
  cleanupSamples,
  intentFile,
  keyFor,
  unresolvedCreateVerdict,
  type ProvisionIntent,
} from '@lib/monday/provision-shell';
import { BRIEFING_AGENDA_COLUMNS } from '@lib/briefing/columns';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

/**
 * Maakt het Briefings-bord: het register van gegenereerde briefings.
 *
 * **Eén rij per GEGENEREERD DOCUMENT, niet per training.** Een training met een lead, een
 * co-trainer en een acteur levert drie bestanden op en dus drie rijen. Dat is precies waarom
 * het bord bestaat: één `Bestandslink`-kolom op het agendabord kan geen drie URL's bevatten,
 * en zo loopt het 1-op-1 met SharePoint.
 *
 * **De relatie naar de agenda is het hele punt.** De eerste opzet gebruikte een tekstkolom met
 * een training-id; daar kan niets doorheen spiegelen, en dan is de itemnaam het enige
 * identificatiemiddel — bevroren bij het aanmaken, verouderd zodra een training verschuift of
 * een klant wordt hernoemd.
 *
 * De checklistantwoorden staan **niet** op dit bord; die leven in de app. Dit bord registreert
 * alleen wat er is geproduceerd.
 *
 *   pnpm briefings:create            # droogloop
 *   pnpm briefings:create --apply
 *
 * Het bord-id wordt direct na aanmaken weggeschreven naar `.briefings-create.json`. Alles
 * daarna is te repareren; het id kwijtraken niet.
 */

const EXIT_FAILURE = 1;
const INTENT_FILE = join(process.cwd(), '.briefings-create.json');

/** Zelfde werkruimte en soort als het agendabord; dit bord bevat klantnamen en documentlinks. */
const WORKSPACE_ID = '5308763';
const BOARD_KIND = 'private';
const BOARD_NAME = 'Briefings';

interface ColumnSpec {
  id: string;
  title: string;
  type: string;
  /** JSON voor `defaults`, of een functie die hem bouwt zodra het relatie-id bekend is. */
  defaults?: (relationColumnId: string) => string;
  /** Een mirror kan door Monday geweigerd worden; dat mag het bord niet slopen. */
  optional?: boolean;
  /**
   * Waar een BESTAANDE kolom aan moet voldoen, naast zijn type.
   *
   * Zonder dit werd een `board_relation` die naar een willekeurig ander bord wijst gemeld als
   * "bestaat al, niets te doen": zelfde type, andere bestemming, leeg register.
   */
  expectRelationBoardIds?: readonly string[];
  expectStatusLabels?: readonly string[];
}

/**
 * De kolommen, in de volgorde waarin ze moeten ontstaan.
 *
 * De relatie eerst: de spiegels verwijzen ernaar en kunnen zonder niet bestaan. `Name` is
 * ingebouwd in Monday en staat er dus niet bij.
 */
const COLUMNS: ColumnSpec[] = [
  {
    id: 'itg_training',
    title: 'Training',
    type: 'board_relation',
    defaults: () =>
      JSON.stringify({ allowCreateReflectionColumn: false, boardIds: [Number(agendaBoardId())] }),
    expectRelationBoardIds: [agendaBoardId()],
  },
  /**
   * Drie spiegels door die relatie heen.
   *
   * **Monday's API maakt een mirror-kolom wel aan maar negeert de `defaults` volledig.**
   * Gemeten op 21-Aug-2026 met drie verschillende vormen (`displayed_linked_columns`,
   * `displayed_column` met bordsleutel, en `mirror_column` als string): de kolom ontstaat,
   * `create_column` meldt succes, en `settings_str` blijft `{}`. Het koppelen van de bronkolom
   * is een handeling in de Monday-interface.
   *
   * Ze worden hier dus wél aangemaakt — met de juiste naam en op de juiste plek — maar iemand
   * moet ze in Monday nog aanwijzen. Het script controleert dat achteraf en zegt het hardop,
   * want een lege spiegel ziet er precies zo uit als een spiegel zonder gegevens.
   */
  {
    id: 'itg_klant',
    title: 'Klant',
    type: 'mirror',
    optional: true,
    defaults: (rel) =>
      JSON.stringify({
        relation_column: { [rel]: true },
        displayed_column: {},
        displayed_linked_columns: { [agendaBoardId()]: [BRIEFING_AGENDA_COLUMNS.opdrachtgever] },
      }),
  },
  {
    id: 'itg_datum',
    title: 'Datum',
    type: 'mirror',
    optional: true,
    defaults: (rel) =>
      JSON.stringify({
        relation_column: { [rel]: true },
        displayed_column: {},
        displayed_linked_columns: { [agendaBoardId()]: [AGENDA_2026_COLUMNS.datum] },
      }),
  },
  {
    id: 'itg_thema',
    title: 'Thema',
    type: 'mirror',
    optional: true,
    defaults: (rel) =>
      JSON.stringify({
        relation_column: { [rel]: true },
        displayed_column: {},
        displayed_linked_columns: { [agendaBoardId()]: [AGENDA_2026_COLUMNS.themaRelation] },
      }),
  },
  { id: 'itg_ontvanger', title: 'Ontvanger', type: 'text' },
  {
    id: 'itg_rol',
    title: 'Rol',
    type: 'status',
    defaults: () =>
      JSON.stringify({ labels: { 1: 'Leadtrainer', 2: 'Co-trainer', 3: 'Trainingsacteur' } }),
    expectStatusLabels: ['Leadtrainer', 'Co-trainer', 'Trainingsacteur'],
  },
  { id: 'itg_bestandslink', title: 'Bestandslink', type: 'link' },
  { id: 'itg_gegenereerd', title: 'Laatst gegenereerd', type: 'date' },
];

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const allowOverride = process.argv.includes('--allow-agenda-override');
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  /**
   * Een bord dat naar de TESTagenda wijst, is niet te repareren door de override weg te halen.
   *
   * `MONDAY_AGENDA_BOARD_ID` bestaat juist om de pijplijn van ITG's echte bord weg te houden,
   * maar dit script maakt een blijvend bord aan in de productiewerkruimte, koppelt het
   * permanent aan wat die variabele aanwijst, en zegt daarna "zet dit id in de code". Een
   * vergeten override wordt zo een permanente verkeerde koppeling.
   */
  const override = agendaOverrideVerdict({
    configured: process.env.MONDAY_AGENDA_BOARD_ID,
    production: AGENDA_2026_PRODUCTION_BOARD,
    apply,
    allowOverride,
  });
  if (override.kind === 'refuse') {
    throw new Error(
      `MONDAY_AGENDA_BOARD_ID staat op ${override.configured}, niet op het productiebord ` +
        `${AGENDA_2026_PRODUCTION_BOARD}.\n` +
        'Het Briefings-bord zou dan permanent aan die kopie hangen, terwijl het id de code in ' +
        'gaat. Kies één van beide:\n' +
        '  - haal de override weg en draai opnieuw, of\n' +
        '  - draai met --allow-agenda-override als je bewust tegen de testagenda bouwt.'
    );
  }

  /** Het agendabord moet bestaan vóórdat we een relatie ernaartoe aanmaken. */
  const agenda = await read.query<{ boards: Array<{ id: string; name: string }> }>(
    'query ($b: [ID!]) { boards(ids: $b) { id name } }',
    { b: [agendaBoardId()] }
  );
  if (agenda.boards?.[0] === undefined) {
    throw new Error(
      `Agendabord ${agendaBoardId()} niet gevonden; de relatie zou nergens heen wijzen.`
    );
  }
  console.log(`\nRelatie gaat naar: ${agenda.boards[0].id} — ${agenda.boards[0].name}\n`);

  const file = intentFile(INTENT_FILE);
  const intent: ProvisionIntent = file.read() ?? {
    runId: `briefings-${Date.now()}`,
    startedAt: Date.now(),
    samples: { phase: 'uncaptured' },
  };
  let boardId = intent.boardId;

  if (boardId === undefined) {
    console.log(
      `${apply ? '  APPLY ' : '  would '}create ${BOARD_KIND} board "${BOARD_NAME}" in workspace ${WORKSPACE_ID}`
    );
    if (apply) {
      /**
       * De sleutel wordt VÓÓR de eerste mutatie vastgelegd.
       *
       * Wachten tot `create_board` antwoordt dekt het geval niet dat echt bijt: Monday maakt
       * het bord en het antwoord gaat verloren. Bij een nieuwe start zou dan een andere
       * `runId` ontstaan, dus een andere sleutel, dus een tweede bord. Dit bestand staat in
       * `.gitignore`, dus datzelfde geldt voor een run vanaf een andere machine.
       */
      file.write(intent);

      const verdict = unresolvedCreateVerdict(intent.startedAt, Date.now());
      if (verdict.kind === 'refuse') {
        throw new Error(
          `Er staat een onafgeronde create van ${verdict.ageMinutes} minuten geleden in ` +
            `${INTENT_FILE}, en Monday's idempotency-venster (30 min) is verlopen. Opnieuw ` +
            'versturen kan een TWEEDE Briefings-bord opleveren.\n' +
            'Kijk in de werkruimte of het bord al bestaat:\n' +
            `  - zo ja:  zet "boardId" in ${INTENT_FILE} en draai opnieuw\n` +
            `  - zo nee: verwijder ${INTENT_FILE} en draai opnieuw.`
        );
      }

      const made = await write.mutate<{ create_board: { id: string } }>(
        `mutation ($name: String!, $workspace: ID!) {
           create_board(board_name: $name, board_kind: ${BOARD_KIND}, workspace_id: $workspace) { id }
         }`,
        { name: BOARD_NAME, workspace: WORKSPACE_ID },
        { idempotencyKey: keyFor(intent, 'create_board') }
      );
      boardId = made.create_board.id;
      // Direct weggeschreven: alles hierna is te repareren, het id kwijtraken niet.
      intent.boardId = boardId;
      file.write(intent);
      console.log(`  bord aangemaakt: ${boardId}  (opgeslagen in ${INTENT_FILE})`);

      // Vastleggen wat van Monday is, op het enige moment dat "alles op dit bord" en
      // "Monday's voorbeeldinhoud" hetzelfde zijn: vóór onze eerste kolom.
      await captureSamples(read, boardId, intent, file);
    }
  } else {
    console.log(`  bord bestaat al uit een eerdere run: ${boardId}`);
  }

  if (!apply || boardId === undefined) {
    for (const spec of COLUMNS) {
      console.log(`  would create column ${spec.id.padEnd(18)} "${spec.title}" (${spec.type})`);
    }
    console.log('\n  Droogloop. Voer uit met --apply om het echt aan te maken.\n');
    return;
  }

  /**
   * `settings_str` hoort erbij, niet alleen het type.
   *
   * Een bestaande `itg_training` die naar een ander bord wijst, of een `itg_rol` met andere
   * labels, heeft exact het type dat we verwachten. Zonder de instellingen te lezen wordt zo'n
   * kolom gemeld als "bestaat al" en bouwt het script vrolijk verder op een register dat nooit
   * iets zal spiegelen.
   */
  /**
   * Opruimen gebeurt **vóór** de eerste kolom, want dat is de invariant waar
   * `sampleCleanupPlan` op steunt: staan onze kolommen er al, dan concludeert hij
   * `already_done` en blijft Monday's voorbeelditem staan.
   *
   * Op een gewone run maakt de volgorde niets uit — `captureSamples` heeft de ids dan al
   * vastgelegd vlak na `create_board`. Het gaat om de **herstelrun**: daar zet een mens
   * alleen `boardId` in het intentiebestand, staat `samples` nog op `uncaptured`, en werd
   * het opruimen overgeslagen omdat de kolommen er inmiddels waren.
   */
  /**
   * Vóór er iets verdwijnt: is dit het bord dat we denken?
   *
   * Zonder merkteken, want dit bord is in augustus aangemaakt en draagt er geen — zie
   * `BoardIdentity.fingerprint`. Naam en werkruimte blijven over, en de echte bescherming
   * zit in `cleanupSamples`: die weigert te verwijderen op een bord dat er niet uitziet als
   * net aangemaakt. Dat werkt zonder merkteken en beschermt tegen de schade zelf.
   */
  await assertBoardIdentity(read, boardId, { name: BOARD_NAME, workspaceId: WORKSPACE_ID });

  await cleanupSamples(read, write, boardId, intent, file, {
    ourColumnIds: COLUMNS.map((c) => c.id),
    groupTitle: 'Gegenereerde briefings',
    log: (line) => console.log(line),
  });

  const meta = await read.query<{
    boards: Array<{ columns: Array<{ id: string; type: string; settings_str?: string | null }> }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { columns { id type settings_str } } }', {
    b: [boardId],
  });
  const boardColumns = meta.boards?.[0]?.columns ?? [];
  const existing = new Map(boardColumns.map((c) => [c.id, c]));

  let relationColumnId = '';
  const skipped: string[] = [];

  for (const spec of COLUMNS) {
    if (spec.type === 'board_relation') {
      relationColumnId = spec.id;
    }
    const already = existing.get(spec.id);
    if (already !== undefined) {
      const verdict = checkColumn(
        {
          id: spec.id,
          type: spec.type,
          relationBoardIds: spec.expectRelationBoardIds,
          statusLabels: spec.expectStatusLabels,
        },
        already
      );
      if (verdict.kind !== 'ok') {
        throw new Error(
          `Kolom ${spec.id}: ${describeVerdict(verdict, spec)}. Handmatig corrigeren; dit ` +
            'script overschrijft geen bestaande kolom.'
        );
      }
      console.log(`  kolom bestaat al: ${spec.id}`);
      continue;
    }

    const defaults = spec.defaults?.(relationColumnId) ?? null;
    try {
      const made = await write.mutate<{ create_column: { id: string } }>(
        `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String!, $defaults: JSON) {
           create_column(board_id: $board, title: $title, column_type: $type, id: $id, defaults: $defaults) { id }
         }`,
        { board: boardId, title: spec.title, type: spec.type, id: spec.id, defaults },
        { idempotencyKey: keyFor(intent, `column:${spec.id}`) }
      );
      console.log(
        `  aangemaakt: ${made.create_column.id.padEnd(18)} "${spec.title}" (${spec.type})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (spec.optional !== true) {
        throw error;
      }
      /**
       * Een geweigerde spiegel is vervelend maar niet fataal: de relatie draagt de betekenis,
       * de spiegel is alleen weergave. Het bord blijft staan en dit meldt wát er ontbreekt.
       */
      skipped.push(`${spec.id} ("${spec.title}"): ${message}`);
      console.log(`  OVERGESLAGEN: ${spec.id} — ${message}`);
    }
  }

  /**
   * Spiegels controleren in plaats van aannemen. `create_column` meldt succes ook als Monday de
   * configuratie heeft genegeerd, en een niet-gekoppelde spiegel is in de interface niet te
   * onderscheiden van een gekoppelde spiegel zonder waarde.
   */
  const na = await read.query<{
    boards: Array<{
      columns: Array<{ id: string; title: string; type: string; settings_str?: string | null }>;
    }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { columns { id title type settings_str } } }', {
    b: [boardId],
  });
  const ongeconfigureerd = (na.boards?.[0]?.columns ?? []).filter(
    (c) => c.type === 'mirror' && (c.settings_str ?? '{}').replace(/\s/g, '') === '{}'
  );

  console.log(`\n  Bord ${boardId} klaar.`);
  if (skipped.length > 0) {
    console.log(`\n  ${skipped.length} kolom(men) niet aangemaakt:`);
    for (const s of skipped) {
      console.log(`     ${s}`);
    }
  }
  if (ongeconfigureerd.length > 0) {
    console.log(
      `\n  HANDWERK NODIG — ${ongeconfigureerd.length} spiegelkolom(men) staan er wel, maar wijzen nergens heen.`
    );
    console.log('  Monday laat dat niet via de API instellen; het moet in de interface:');
    for (const c of ongeconfigureerd) {
      const bron =
        c.id === 'itg_klant'
          ? 'Bedrijf'
          : c.id === 'itg_datum'
            ? 'Datum'
            : c.id === 'itg_thema'
              ? "Thema's"
              : '?';
      console.log(
        `     ${c.id.padEnd(16)} "${c.title}"  →  kolom via Training, toon "${bron}" van Agenda 2026`
      );
    }
  }
  console.log(`\n  Zet dit id in de code: BRIEFINGS_BOARD = '${boardId}'\n`);
}

/** Hoe een afgekeurde kolom in de foutmelding komt te staan. */
function describeVerdict(verdict: ColumnVerdict, spec: ColumnSpec): string {
  switch (verdict.kind) {
    case 'wrong_type':
      return `bestaat al als '${verdict.found}', verwacht '${spec.type}'`;
    case 'wrong_relation':
      return `is een relatie naar bord ${verdict.found.join(', ')}, verwacht ${verdict.expected.join(', ')}`;
    case 'wrong_labels':
      return `mist de labels ${verdict.missing.join(', ')}`;
    case 'unreadable_settings':
      return 'bestaat al, maar de instellingen zijn niet te lezen';
    case 'ok':
      return 'klopt';
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
