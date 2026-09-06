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
 *   pnpm eval:reports --date 2026-09-01 --apply --geen-mail
 *
 * **Droogloop is de standaard**: zonder `--apply` wordt er niets geschreven en niets verstuurd.
 * Mét `--apply` gaat het naar het live agendabord van de klant én gaan er echte mails naar
 * ITG's gedeelde postbussen.
 *
 * **De verzendkant wordt alleen bij `--apply` aangesloten.** Bij een droogloop wordt er toch
 * niets verstuurd, en het bouwen van die kant eist Graph- en Redis-sleutels die op een
 * werkplek niet altijd staan — dan zou een onschuldige droogloop struikelen over een
 * verzender die hij niet gaat gebruiken. Wil je de teksten zien: `pnpm mail:preview <item>`.
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const geenMail = args.includes('--geen-mail');
  const dateIndex = args.indexOf('--date');
  const requested = dateIndex === -1 ? null : args[dateIndex + 1];

  if (requested !== null && !/^\d{4}-\d{2}-\d{2}$/.test(requested ?? '')) {
    throw new Error('--date moet YYYY-MM-DD zijn');
  }
  const date = requested ?? previousDay(amsterdamToday(new Date()));

  const { deps, boardId } = buildDailyReportDeps({ date, mail: apply && !geenMail });
  const mailStand = !apply ? 'geen mail (droogloop)' : geenMail ? 'geen mail' : 'mail AAN';
  console.log(
    `\nDagverwerking ${date} — bord ${boardId} — ${apply ? 'APPLY' : 'droogloop'} — ${mailStand}\n`
  );

  const report = await runDailyReports(deps, { date, boardId, dryRun: !apply });

  if (report.delivery !== null) {
    const waar = `${report.delivery.klant} / ${report.delivery.trainer}`;
    console.log(
      report.delivery.redirected
        ? `  !! OMGELEID — mails gaan naar ${waar}, NIET naar de echte postbussen\n`
        : `  Bestemming: ${waar}\n`
    );
  }

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
    if (line.mailNote !== '') {
      console.log(`  ${''.padEnd(13)} ${''.padEnd(15)} ${''.padEnd(11)} → ${line.mailNote}`);
    }
    for (const warning of line.warnings) {
      console.log(`  ${''.padEnd(13)} ${''.padEnd(15)} ${''.padEnd(11)} !! huisstijl: ${warning}`);
    }
  }

  const totals = Object.entries(report.totals)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  console.log(
    `\n  ${report.considered} trainingen  |  ${totals}  |  geschreven: ${report.written}` +
      `  |  mails: ${report.mailed}`
  );
  if (report.mailFailures.length > 0) {
    console.log(`  MISLUKT bij: ${report.mailFailures.join(', ')}`);
    /**
     * Een niet-nul afsluitcode, net als de 500 van de croneroute.
     *
     * Alleen printen laat het script met 0 eindigen terwijl er mails niet verstuurd zijn, en
     * dan leest elk herstelscript en elke operator die op de afsluitcode kijkt de run als
     * geslaagd. De bordkant is wél bijgewerkt; dat verandert er niets aan.
     */
    process.exitCode = EXIT_FAILURE;
  }
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
