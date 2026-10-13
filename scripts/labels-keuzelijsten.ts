/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import { STATUS_KLEUR, leesStatusOpties } from '@lib/labels/keuzelijst';
import {
  buildKeuzelijstDeps,
  heeftFouten,
  leesKeuzelijst,
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
 *
 * **`--proef` vóór de eerste `--apply`.** Monday wil bij het toevoegen de HELE lijst labels terug,
 * met de kleur als naam, en geeft hem als nummer. Klopt die vertaling niet, dan kleurt elk label
 * om. De proef kopieert de STRUCTUUR van het Opportunitybord (geen items, dus geen automatiseringen
 * die afgaan), voegt daar een label toe met precies dezelfde code, vergelijkt elk label voor en na,
 * toetst alle 40 kleuren op een eigen kolom, en verwijdert de kopie. Raakt niets van ITG.
 */

const EXIT_FAILURE = 1;
const PROEF_NAAM = 'Lerai proef keuzelijst (mag weg)';
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

async function proef(): Promise<boolean> {
  const token = process.env.MONDAY_API_TOKEN ?? '';
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  const kopie = await write.mutate<{ duplicate_board: { board: { id: string } } }>(
    `mutation ($b: ID!, $naam: String!) {
       duplicate_board(board_id: $b, duplicate_type: duplicate_board_with_structure,
                       board_name: $naam, keep_subscribers: false) { board { id } }
     }`,
    { b: OPPORTUNITY_BOARD, naam: PROEF_NAAM }
  );
  const boardId = String(kopie.duplicate_board.board.id);
  console.log(`\n  wegwerpkopie van het Opportunitybord: ${boardId}\n`);
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
    const geslaagd = gelijk && !heeftFouten(rapport) && kleurfouten === 0;
    console.log(
      `\n  PROEF ${geslaagd ? 'GESLAAGD: --apply is veilig' : 'MISLUKT: niet --apply draaien, stuur dit naar Lerai'}\n`
    );
    return geslaagd;
  } finally {
    await write.mutate('mutation ($b: ID!) { delete_board(board_id: $b) { id } }', { b: boardId });
    console.log(`  wegwerpkopie ${boardId} verwijderd`);
  }
}

async function main(): Promise<void> {
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
