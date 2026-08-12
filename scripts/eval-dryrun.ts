/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitNightly, prepareNightly, runTierA } from '@lib/evaluations';
import { buildEvalStatsDeps } from '@lib/recommend';

import type { NightlyReport } from '@lib/evaluations';

/**
 * The whole chain, against live data — reported, and optionally published.
 *
 * Sheets → attribution → Agenda history → qualifications → the trainer×thema rows, then
 * the Tier A parity gate, then (with `--apply`) the write.
 *
 * ONE read. `prepareNightly` runs the chain exactly once and everything below is
 * rendered from what it returned; `commitNightly` publishes that same object. Reading a
 * second time in order to write would publish a dataset nobody looked at — the operator
 * would approve one set of numbers and ship another.
 *
 *   doppler run -c prd -- pnpm eval:dryrun                        # report only
 *   doppler run -c prd -- pnpm eval:dryrun --apply                # write, if the gate passes
 *   doppler run -c prd -- pnpm eval:dryrun --apply --bootstrap    # create the FIRST record
 */

const AIRTABLE_DIR = join(process.cwd(), 'snapshots', 'airtable');
const airtable = (name: string): string => join(AIRTABLE_DIR, `${name}.json`);

const pct = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

function renderSources(report: NightlyReport): void {
  console.log('\n── Bronnen ───────────────────────────────────────────────');
  for (const sheet of report.sheets) {
    console.log(
      `  ${sheet.source.label.padEnd(9)} ${String(sheet.responses).padStart(5)} reacties ` +
        `(cijfer=kolom ${sheet.columns.grade})`
    );
  }
  console.log(
    `  ${'totaal'.padEnd(9)} ${String(report.attribution.totalResponses).padStart(5)} reacties`
  );
  for (const board of report.perBoard) {
    console.log(`  Agenda ${board.jaargang}  ${String(board.items).padStart(5)} trainingen`);
  }
  console.log(
    `  Kwalificaties ${String(report.qualificationPairs).padStart(4)} trainer×thema-paren`
  );
}

function renderAttribution(report: NightlyReport): void {
  const { attribution } = report;
  console.log('\n── Toewijzing ────────────────────────────────────────────');
  console.log(
    `  toegewezen   ${attribution.attributedResponses}/${attribution.totalResponses} ` +
      `(${pct(attribution.attributedResponses, attribution.totalResponses)})`
  );
  for (const kind of ['ambiguous_code', 'unknown_code', 'case_only_miss', 'blank_code'] as const) {
    const losses = attribution.losses.filter((loss) => loss.kind === kind);
    const count = losses.reduce((sum, loss) => sum + loss.responseCount, 0);
    if (count > 0) {
      console.log(
        `  ${kind.padEnd(14)} ${String(count).padStart(4)} reacties in ${losses.length} codes`
      );
    }
  }
  console.log(`  trainingen zonder IE-code: ${attribution.trainingsWithoutCode}`);
}

function renderRows(report: NightlyReport): void {
  const { stats } = report;
  console.log('\n── Gewenste set ──────────────────────────────────────────');
  console.log(`  vandaag (Amsterdam)   ${report.today}`);
  console.log(`  afgerond              ${stats.completed}/${stats.historyTotal}`);
  console.log(`  zonder datum          ${stats.skippedUndated}`);
  console.log(`  zonder trainer/thema  ${stats.skippedNoTrainer}/${stats.skippedNoThema}`);
  console.log(`  RIJEN                 ${report.rows}`);
  console.log(`    met evaluaties      ${report.rowsWithEvaluations}`);
  console.log(`    alleen kwalificatie ${report.rowsQualificationOnly}`);
  console.log(`    omvang              ${report.bytes} bytes`);

  /**
   * The wrong-column-map alarm. Reading a jaargang with another year's relation ids
   * yields trainer-less trainings and NO error; every one of them still has responses,
   * so they all surface here.
   */
  if (stats.aggregatesUnused.length > 0) {
    console.log(
      `\n  ⚠ ${stats.aggregatesUnused.length} trainingen hebben reacties maar bereikten geen ` +
        `enkel paar (geen trainer/thema, of een verkeerde kolom-map)`
    );
    console.log(`    eerste: ${stats.aggregatesUnused.slice(0, 5).join(', ')}`);
  }
}

/**
 * The publish gate. FAIL CLOSED: no snapshots, no write.
 *
 * A row-count comparison cannot see a wrong average, a wrong count or a broken join, and
 * "snapshot ontbreekt, dus doorgaan" is the absence of a gate at exactly the moment one
 * is needed.
 */
function renderGate(): { ok: boolean; detail: string } {
  console.log('\n── Pariteitsgate (Tier A) ────────────────────────────────');
  const needed = ['trainingen', 'trainer_thema_stats', 'trainers'];
  const missing = needed.filter((name) => !existsSync(airtable(name)));
  if (missing.length > 0) {
    const detail =
      `Airtable-snapshot ontbreekt (${missing.join(', ')}) — draai \`pnpm snapshot:airtable\``;
    console.log(`  ✗ ${detail}`);
    return { ok: false, detail };
  }

  const result = runTierA(
    JSON.parse(readFileSync(airtable('trainingen'), 'utf8')),
    JSON.parse(readFileSync(airtable('trainer_thema_stats'), 'utf8')),
    JSON.parse(readFileSync(airtable('trainers'), 'utf8'))
  );
  console.log(`  vergeleken            ${result.compared} rijen`);
  console.log(`  trainerbreed          ${result.trainersCompared} trainers`);
  console.log(`  niet gemaakt (leeg)   ${result.notProduced}`);
  console.log(
    `  afwijkingen           ${result.mismatches.length}, ` +
      `waarvan verklaard ${result.mismatches.length - result.unexplained.length}`
  );
  for (const mismatch of result.unexplained.slice(0, 10)) {
    console.log(
      `    ✗ ${mismatch.statsRowId} ${mismatch.field}: ` +
        `airtable ${mismatch.airtable} vs onze ${mismatch.ours}`
    );
  }
  const ok = result.unexplained.length === 0;
  const detail = ok
    ? 'alle afwijkingen verklaard'
    : `${result.unexplained.length} onverklaarde afwijking(en)`;
  console.log(`  ${ok ? '✓' : '✗'} ${detail}`);
  return { ok, detail };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  /**
   * The first record has no baseline, so the drop guard cannot run. Creating one is a
   * deliberate act by a human looking at the gate below, never something the cron does.
   */
  const bootstrap = process.argv.includes('--bootstrap');

  const deps = buildEvalStatsDeps();
  const prepared = await prepareNightly(deps, { dryRun: !apply, bootstrap });
  const { report } = prepared;

  renderSources(report);
  renderAttribution(report);
  renderRows(report);
  const gate = renderGate();

  if (report.refused !== null) {
    console.log(`\n✗ GEWEIGERD (${report.refused}): ${report.detail ?? ''}`);
    console.log('  Het vorige record is ongemoeid gelaten.\n');
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log('\nNiets geschreven. Dit is een droogloop — voeg --apply toe om te schrijven.\n');
    return;
  }
  if (!gate.ok) {
    console.log(`\n✗ NIET GESCHREVEN: de pariteitsgate is niet gehaald (${gate.detail}).\n`);
    process.exitCode = 1;
    return;
  }

  const written = await commitNightly(deps, prepared);
  console.log(`\n✓ Geschreven: ${written.rows} rijen, ${written.bytes} bytes.\n`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
