/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { amsterdamToday } from '@lib/evaluations';
import { previousDay, runDailyReports } from '@lib/report/daily';
import { buildDailyReportDeps } from '@lib/report/deps';

/**
 * De dagjob met de hand draaien. Zelfde aansluitingen als de cron, via `buildDailyReportDeps`.
 *
 *   pnpm eval:reports                      # droogloop over gisteren
 *   pnpm eval:reports --date 2026-09-01
 *   pnpm eval:reports --date 2026-09-01 --apply
 *
 * Droogloop is de standaard: dit schrijft naar het live agendabord van de klant.
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dateIndex = args.indexOf('--date');
  const requested = dateIndex === -1 ? null : args[dateIndex + 1];

  if (requested !== null && !/^\d{4}-\d{2}-\d{2}$/.test(requested ?? '')) {
    throw new Error('--date moet YYYY-MM-DD zijn');
  }
  const date = requested ?? previousDay(amsterdamToday(new Date()));

  const { deps, boardId } = buildDailyReportDeps({ date });
  console.log(`\nDagverwerking ${date} — bord ${boardId} — ${apply ? 'APPLY' : 'droogloop'}\n`);

  const report = await runDailyReports(deps, { date, boardId, dryRun: !apply });

  if (report.considered === 0) {
    console.log('  Geen trainingen op die datum.\n');
    return;
  }

  console.log('  item          resultaat       geschreven  training / samenvatting');
  for (const line of report.lines) {
    console.log(
      `  ${line.itemId.padEnd(13)} ${line.result.padEnd(15)} ${(line.wrote ? 'ja' : 'nee').padEnd(11)} ` +
        `${line.klanttitel.slice(0, 28).padEnd(30)} ${line.summary}`
    );
  }

  const totals = Object.entries(report.totals)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  console.log(
    `\n  ${report.considered} trainingen  |  ${totals}  |  geschreven: ${report.written}`
  );
  if (!apply) {
    console.log('  Droogloop. Voer uit met --apply om het echt weg te schrijven.\n');
  } else {
    console.log('');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
