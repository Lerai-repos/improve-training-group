/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import { labelsBoardId } from '@lib/labels';
import { STATUS_KLEUR, alsInvoer, controleerNa, leesStatusOpties } from '@lib/labels/keuzelijst';
import {
  buildKeuzelijstDeps,
  heeftFouten,
  leesDoelen,
  leesKeuzelijst,
  schrijfKeuzelijst,
  syncKeuzelijsten,
} from '@lib/labels/keuzelijst-sync';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import type { KeuzelijstDoel, KeuzelijstRapport } from '@lib/labels/keuzelijst-sync';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';

/**
 * De labels van het Labels-bord in de keuzelijsten zetten: `Label` op de Opportunity en `status23`
 * op elk actief agendabord.
 *
 *   pnpm labels:keuzelijsten              # droogloop: welk label waar zou bijkomen
 *   pnpm labels:keuzelijsten --apply      # echt toevoegen
 *   pnpm labels:keuzelijsten --proef      # eerst dit: op een wegwerpkopie, zie hieronder
 *   pnpm labels:keuzelijsten --proef --bord <id>   # op een bestaande proefkopie, die blijft staan
 *   pnpm labels:keuzelijsten --rechten    # alleen stap 1 hieronder: mag Automatisering schrijven?
 *   pnpm labels:keuzelijsten --opruimen   # proefkopieën weghalen als de proef halverwege stopte
 *
 * **`--proef` vóór de eerste `--apply`.** Monday wil bij het toevoegen de HELE lijst labels terug,
 * met de kleur als naam, en geeft hem als nummer. Klopt die vertaling niet, dan kleurt elk label
 * om. De proef doet twee dingen, en raakt niets van ITG:
 *
 * 1. **Rechten.** `Automatisering` is beheerder maar geen eigenaar van de Opportunity en de agenda.
 *    Per echte keuzelijst stuurt de proef de huidige lijst ongewijzigd terug met een bewust
 *    ONGELDIGE revisie: Monday weigert dat altijd, en de foutmelding zegt of het om rechten gaat
 *    of om de revisie (dan zijn de rechten in orde). Er verandert niets.
 * 2. **Kleuren.** Kopieert de STRUCTUUR van het Opportunitybord naar de werkruimte van het
 *    Labels-bord (geen items, dus geen automatiseringen die afgaan), voegt daar een label toe met
 *    precies dezelfde code, vergelijkt elk label voor en na, toetst alle 40 kleuren op een eigen
 *    kolom, en verwijdert de kopie.
 */

const EXIT_FAILURE = 1;
const PROEF_NAAM = 'Lerai proef keuzelijst (mag weg)';
/** Een bord kopiëren duurt bij het Opportunitybord ruim langer dan een gewone schrijfactie. */
const KOPIEER_TIMEOUT_MS = 120_000;
/** Een revisie die nooit bestaat, zodat Monday de rechtenproef altijd weigert. */
const ONGELDIGE_REVISIE = 'lerai-rechtenproef-ongeldig';
const WACHT_MS = 2_000;
const WACHT_POGINGEN = 15;

function toon(rapport: KeuzelijstRapport): void {
  console.log(`  labels op het Labels-bord: ${rapport.gewenst.join(', ')}\n`);
  for (const { doel, uitkomst } of rapport.doelen) {
    const regel =
      uitkomst.kind === 'compleet'
        ? 'compleet'
        : uitkomst.kind === 'mislukt'
          ? `MISLUKT: ${uitkomst.fout}`
          : `${uitkomst.kind}: ${uitkomst.namen.join(', ')}`;
    console.log(`  ${doel.naam.padEnd(28)} ${regel}`);
  }
  console.log('');
}

const slaap = (ms: number): Promise<void> => new Promise((klaar) => setTimeout(klaar, ms));

/** De kopie is er pas als zijn kolommen te lezen zijn; dupliceren loopt even. */
async function wachtOpKolom(read: MondayGraphQLClient, doel: KeuzelijstDoel): Promise<void> {
  for (let poging = 0; poging < WACHT_POGINGEN; poging += 1) {
    try {
      await leesKeuzelijst(read, doel);
      return;
    } catch {
      await slaap(WACHT_MS);
    }
  }
  throw new Error(
    `De kopie ${doel.boardId} heeft na ${WACHT_POGINGEN} pogingen nog geen kolom ${doel.kolomId}.`
  );
}

/** Alle 40 kleuren op een eigen kolom: komt elk nummer terug zoals onze tabel zegt? */
async function kleurenToets(
  read: MondayGraphQLClient,
  write: MondayMutationClient,
  boardId: string
): Promise<number> {
  const namen = Object.entries(STATUS_KLEUR);
  const gemaakt = await write.mutate<{ create_status_column: { id: string } }>(
    `mutation ($b: ID!, $labels: [CreateStatusLabelInput!]!) {
       create_status_column(board_id: $b, title: "Kleurentoets", defaults: { labels: $labels }) { id }
     }`,
    {
      b: boardId,
      labels: namen.map(([, kleur], index) => ({ label: `K-${kleur}`, color: kleur, index })),
    }
  );
  const kolom = await read.query<{ boards?: Array<{ columns?: Array<{ settings?: unknown }> }> }>(
    'query ($b: [ID!], $c: [String!]) { boards(ids: $b) { columns(ids: $c) { settings } } }',
    { b: [boardId], c: [gemaakt.create_status_column.id] }
  );
  const opties = leesStatusOpties(kolom.boards?.[0]?.columns?.[0]?.settings, 'kleurentoets');
  let fout = 0;
  for (const [nummer, kleur] of namen) {
    const terug = opties.find((o) => o.label === `K-${kleur}`);
    if (terug === undefined || terug.color !== Number(nummer)) {
      fout += 1;
      console.log(`     ${kleur}: verwacht ${nummer}, kreeg ${terug?.color ?? 'niets'}`);
    }
  }
  console.log(`  kleurentoets: ${namen.length - fout} van ${namen.length} kleuren kloppen`);
  return fout;
}

/**
 * Mag `Automatisering` de echte keuzelijsten aanpassen? Zie stap 1 bovenaan.
 *
 * Neemt Monday de wijziging tóch aan, dan was het de ongewijzigde lijst; de proef leest hem terug
 * en vergelijkt elk label, zodat ook dat geval zichtbaar is.
 */
async function rechtenProef(
  read: MondayGraphQLClient,
  write: MondayMutationClient
): Promise<boolean> {
  let goed = true;
  console.log('\n  Rechten op de echte keuzelijsten (er verandert niets):\n');
  for (const doel of await leesDoelen(read)) {
    const voor = await leesKeuzelijst(read, doel);
    try {
      await schrijfKeuzelijst(write, doel, ONGELDIGE_REVISIE, alsInvoer(voor.opties, doel.naam));
    } catch (error) {
      const melding = error instanceof Error ? error.message : String(error);
      const geenRechten = /unauthori[sz]ed|permission|forbidden/i.test(melding);
      goed &&= !geenRechten;
      console.log(
        `  ${doel.naam.padEnd(28)} ${geenRechten ? 'GEEN RECHTEN' : 'rechten in orde'} (${melding})`
      );
      continue;
    }
    const problemen = controleerNa(voor.opties, (await leesKeuzelijst(read, doel)).opties, []);
    goed &&= problemen.length === 0;
    console.log(
      `  ${doel.naam.padEnd(28)} LET OP: Monday nam een ongeldige revisie aan; ` +
        (problemen.length === 0 ? 'de lijst is ongewijzigd' : `VERSCHIL: ${problemen.join('; ')}`)
    );
  }
  return goed;
}

/** De werkruimte van het Labels-bord: daar mag `Automatisering` borden maken. */
async function eigenWerkruimte(read: MondayGraphQLClient): Promise<string> {
  const data = await read.query<{ boards?: Array<{ workspace?: { id: string } | null }> }>(
    'query ($b: [ID!]) { boards(ids: $b) { workspace { id } } }',
    { b: [labelsBoardId()] }
  );
  const id = data.boards?.[0]?.workspace?.id;
  if (id === undefined) {
    throw new Error('De werkruimte van het Labels-bord is niet te lezen.');
  }
  return String(id);
}

/** De waarde na een vlag, of `null`. */
function argument(vlag: string): string | null {
  const i = process.argv.indexOf(vlag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * Een nieuwe wegwerpkopie van het Opportunitybord, in de eigen werkruimte.
 *
 * Een eigen client: kopiëren duurt langer dan de standaard 15 seconden, en een nieuwe poging na
 * een time-out maakt een TWEEDE kopie (13-Oct-2026: zo ontstonden er twee).
 */
async function maakKopie(read: MondayGraphQLClient, token: string): Promise<string> {
  const kopieerder = createMondayMutationClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    timeoutMs: KOPIEER_TIMEOUT_MS,
    attempts: 1,
  });
  const kopie = await kopieerder.mutate<{ duplicate_board: { board: { id: string } } }>(
    `mutation ($b: ID!, $naam: String!, $w: ID!) {
       duplicate_board(board_id: $b, duplicate_type: duplicate_board_with_structure,
                       board_name: $naam, keep_subscribers: false, workspace_id: $w) { board { id } }
     }`,
    { b: OPPORTUNITY_BOARD, naam: PROEF_NAAM, w: await eigenWerkruimte(read) }
  );
  return String(kopie.duplicate_board.board.id);
}

/**
 * Een eerder gemaakte proefkopie, maar alleen als het er écht een is: de proef schrijft in de
 * labelkolom, en een verkeerd bord-id mag nooit een echt bord van ITG raken.
 */
async function keurKopie(read: MondayGraphQLClient, boardId: string): Promise<string> {
  const data = await read.query<{
    boards?: Array<{ name: string; workspace?: { id: string } | null }>;
  }>('query ($b: [ID!]) { boards(ids: $b) { name workspace { id } } }', { b: [boardId] });
  const bord = data.boards?.[0];
  if (bord?.name !== PROEF_NAAM || String(bord.workspace?.id) !== (await eigenWerkruimte(read))) {
    throw new Error(
      `Bord ${boardId} is geen proefkopie ("${PROEF_NAAM}" in de werkruimte van het Labels-bord). ` +
        'Gestopt zonder iets te schrijven.'
    );
  }
  return boardId;
}

async function proef(): Promise<boolean> {
  const token = process.env.MONDAY_API_TOKEN ?? '';
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  const rechten = await rechtenProef(read, write);

  const bestaand = argument('--bord');
  const boardId =
    bestaand === null ? await maakKopie(read, token) : await keurKopie(read, bestaand);
  console.log(
    `\n  ${bestaand === null ? 'wegwerpkopie' : 'bestaande proefkopie'} van het Opportunitybord: ${boardId}\n`
  );
  try {
    const doel: KeuzelijstDoel = {
      boardId,
      kolomId: OPPORTUNITY_COLUMNS.label,
      naam: 'proefkopie',
    };
    await wachtOpKolom(read, doel);

    const origineel = await leesKeuzelijst(read, {
      boardId: OPPORTUNITY_BOARD,
      kolomId: OPPORTUNITY_COLUMNS.label,
      naam: 'Opportunities',
    });
    const kopieVoor = await leesKeuzelijst(read, doel);
    const gelijk =
      JSON.stringify(origineel.opties.map((o) => [o.id, o.label, o.color, o.hex])) ===
      JSON.stringify(kopieVoor.opties.map((o) => [o.id, o.label, o.color, o.hex]));
    console.log(`  de kopie heeft dezelfde labels als het origineel: ${gelijk ? 'ja' : 'NEE'}`);

    const basis = buildKeuzelijstDeps({ dryRun: false, doelen: [doel] });
    const rapport = await syncKeuzelijsten({
      ...basis,
      gewenst: async () => [...(await basis.gewenst()), `PROEF-${Date.now()}`],
    });
    toon(rapport);

    const kleurfouten = await kleurenToets(read, write, boardId);
    const geslaagd = rechten && gelijk && !heeftFouten(rapport) && kleurfouten === 0;
    console.log(
      `\n  PROEF ${geslaagd ? 'GESLAAGD: --apply is veilig' : 'MISLUKT: niet --apply draaien, stuur dit naar Lerai'}\n`
    );
    return geslaagd;
  } finally {
    // Geen `return` hier: dat zou de uitkomst van de proef overschrijven.
    if (bestaand !== null) {
      console.log(`  proefkopie ${boardId} blijft staan (meegegeven met --bord)`);
    } else {
      try {
        console.log(`  wegwerpkopie ${boardId} ${await ruimOp(write, boardId)}`);
      } catch (error) {
        console.log(
          `  wegwerpkopie ${boardId} NIET weggehaald (${error instanceof Error ? error.message : String(error)}); ` +
            'draai --opruimen of haal hem met de hand weg'
        );
      }
    }
  }
}

/**
 * Achtergebleven proefkopieën weghalen, voor als de proef halverwege stopte. Alleen borden met
 * precies de proefnaam, en alleen in de eigen werkruimte; de subitemborden gaan mee.
 */
/**
 * Een proefbord weghalen: verwijderen, en lukt dat niet, archiveren.
 *
 * Monday gaf op 13-Oct-2026 een interne fout op `delete_board` voor een gekopieerd bord dat van
 * ons was en leeg; archiveren haalt het dan in elk geval uit beeld.
 */
async function ruimOp(write: MondayMutationClient, boardId: string): Promise<string> {
  try {
    await write.mutate('mutation ($b: ID!) { delete_board(board_id: $b) { id } }', { b: boardId });
    return 'verwijderd';
  } catch (verwijderFout) {
    try {
      await write.mutate('mutation ($b: ID!) { archive_board(board_id: $b) { id } }', {
        b: boardId,
      });
      return 'gearchiveerd (verwijderen lukte niet)';
    } catch (archiveerFout) {
      const melding = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      throw new Error(
        `verwijderen: ${melding(verwijderFout)}; archiveren: ${melding(archiveerFout)}`
      );
    }
  }
}

async function opruimen(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN ?? '';
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const werkruimte = await eigenWerkruimte(read);
  const namen = new Set([PROEF_NAAM, `Subitems van ${PROEF_NAAM}`]);
  const data = await read.query<{ boards: Array<{ id: string; name: string }> }>(
    'query ($w: [ID!]) { boards(workspace_ids: $w, state: active, limit: 500) { id name } }',
    { w: [werkruimte] }
  );
  const weg = data.boards.filter((b) => namen.has(b.name));
  console.log(`\n  ${weg.length} proefborden gevonden in werkruimte ${werkruimte}\n`);
  for (const bord of weg) {
    try {
      console.log(`  ${await ruimOp(write, bord.id)}: ${bord.id}  ${bord.name}`);
    } catch (error) {
      // Een subitembord verdwijnt vaak al met zijn hoofdbord.
      console.log(
        `  overgeslagen: ${bord.id} (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  if (process.argv.includes('--rechten')) {
    const token = process.env.MONDAY_API_TOKEN ?? '';
    const goed = await rechtenProef(
      createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION }),
      createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION })
    );
    console.log(`\n  RECHTEN ${goed ? 'IN ORDE' : 'ONTBREKEN'}\n`);
    if (!goed) {
      process.exit(EXIT_FAILURE);
    }
    return;
  }
  if (process.argv.includes('--opruimen')) {
    await opruimen();
    return;
  }
  if (process.argv.includes('--proef')) {
    if (!(await proef())) {
      process.exit(EXIT_FAILURE);
    }
    return;
  }
  const apply = process.argv.includes('--apply');
  const rapport = await syncKeuzelijsten(buildKeuzelijstDeps({ dryRun: !apply }));
  console.log(`\nKeuzelijsten — ${apply ? 'APPLY' : 'droogloop'}\n`);
  toon(rapport);
  if (!apply) {
    console.log('  Droogloop. Eerst --proef, daarna --apply om het echt toe te voegen.\n');
  }
  if (heeftFouten(rapport)) {
    process.exit(EXIT_FAILURE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
