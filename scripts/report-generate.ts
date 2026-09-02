/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { buildReportRunDeps } from '@lib/report/deps';
import { runReport } from '@lib/report/run';

/**
 * Eén echt evaluatierapport, volledig live. Nog een script, nog geen route.
 *
 *   pnpm report:generate <agenda-item-id> [--out bestand.pdf]
 *
 * Leest de responses uit Google Sheets, de training van het agendabord en de huisstijl van
 * het Labels-bord — geen enkele vaste waarde meer.
 */

const EXIT_FAILURE = 1;
const OUT_DIR = join(process.cwd(), 'report-output');
/** Alleen leesbaar voor de eigenaar: dit is klantmateriaal, geen build-artefact. */
const OWNER_ONLY = 0o600;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const itemId = args.find((a) => !a.startsWith('--'));
  const outIndex = args.indexOf('--out');
  /**
   * Standaard in `report-output/`, een map die in `.gitignore` staat.
   *
   * NIET in de repowortel. Een rapport bevat de klantnaam, de trainersnaam en de letterlijke
   * antwoorden van deelnemers; belandt zo'n bestand naast de broncode, dan zet één `git add .`
   * het in de geschiedenis. Een genegeerde map maakt dat onmogelijk in plaats van
   * onwaarschijnlijk.
   */
  const out = outIndex === -1 ? join(OUT_DIR, `rapport-${itemId}.pdf`) : args[outIndex + 1];

  if (itemId === undefined) {
    throw new Error('Gebruik: pnpm report:generate <agenda-item-id> [--out bestand.pdf]');
  }
  // `buildReportRunDeps` werpt zelf op een ontbrekend token.
  const outcome = await runReport(itemId, buildReportRunDeps());

  if (outcome.kind === 'not_found') {
    throw new Error(`Agenda-item ${itemId} niet gevonden.`);
  }

  const t = outcome.training;
  console.log(`\n  training  ${t.klanttitel}`);
  console.log(`  label     ${t.rawLabel || '(leeg)'} → ${t.labelCode ?? 'ONBEKEND'}`);
  console.log(`  code      ${t.rawIeCode ?? '(geen)'}`);
  console.log(`  trainers  ${t.trainerNamen.join(', ') || '(geen)'}`);
  console.log(`  contact   ${t.contactPersoon || '(leeg)'}\n`);

  switch (outcome.kind) {
    case 'unknown_label':
      throw new Error(
        `Label "${t.rawLabel}" heeft geen configuratie. Er wordt geen rapport gemaakt: ` +
          'raden zou een document in de huisstijl van een ander merk opleveren.'
      );
    case 'no_code':
      console.log('  GEEN RAPPORT: deze training heeft geen IE-code.\n');
      return;
    case 'missing_trainer':
      console.log(
        '  GEEN RAPPORT: er is geen trainer gekoppeld.\n' +
          '  De introzin noemt de trainer bij naam; zonder naam staat daar een leeg vet vak.\n'
      );
      return;
    case 'ambiguous_code':
      console.log(
        '  GEEN RAPPORT: deze IE-code wordt ook door een andere klant gebruikt.\n' +
          '  Er ZIJN reacties, maar ze zijn niet eenduidig toe te wijzen — corrigeer de\n' +
          '  dubbele code op het agendabord.\n'
      );
      return;
    case 'no_responses':
      console.log(
        "  GEEN RAPPORT: nul reacties op deze code — de 'geen data'-situatie.\n" +
          '  Status op Onvindbaar en de ZONDER-mails zijn nog niet gebouwd.\n'
      );
      return;
    case 'ok':
      break;
  }

  for (const warning of outcome.report.warnings) {
    console.log(`  LET OP: ${warning}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(out, outcome.report.pdf, { mode: OWNER_ONLY });
  console.log(
    `  ${outcome.report.responseCount} reacties  |  ` +
      `PDF ${(outcome.report.pdf.byteLength / 1024 / 1024).toFixed(2)} MB → ${out}\n`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
