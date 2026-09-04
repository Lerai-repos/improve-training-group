/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { currentDeadlineMs, runWithDeadline } from '@lib/recommend';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildDailyCheckDeps,
  buildSignalLease,
  findingName,
  LEASE_TTL_MS,
  runDailyCheckExclusive,
  signalGroups,
} from '@lib/signals';
import { systeemBoardId } from '@lib/signals/board';

/**
 * De dagelijkse controle met de hand draaien. Zelfde aansluitingen als de cron.
 *
 *   pnpm daily:check           # droogloop — leest alles, schrijft niets
 *   pnpm daily:check --apply
 */

const EXIT_FAILURE = 1;

/**
 * De looptijdgrens van een handmatige run, en waarom hij bestaat.
 *
 * Zonder deadline bouwt dit script Monday-clients die onbegrensd mogen doorwerken: schema's,
 * paginering, hernieuwde pogingen en schrijfacties achter elkaar kunnen bij traagheid ruim over
 * de vijf minuten van `LEASE_TTL_MS` heen. Dan verloopt de grendel terwijl deze run nog schrijft
 * en kan een tweede run erin — precies de gelijktijdigheid die de grendel moet voorkomen.
 *
 * Ruim onder de TTL, zodat de run zichzelf afkapt vóórdat zijn grendel verloopt.
 */
const RUN_DEADLINE_MS = LEASE_TTL_MS - 60_000;

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const groups = await signalGroups(client, systeemBoardId());
  const { deps, boardId } = buildDailyCheckDeps({
    dryRun: !apply,
    groups,
    deadlineMs: currentDeadlineMs,
  });

  console.log(
    `\nDagelijkse controle — Systeem-bord ${boardId} — ${apply ? 'APPLY' : 'droogloop'}\n`
  );

  const outcome = await runWithDeadline(Date.now() + RUN_DEADLINE_MS, () =>
    runDailyCheckExclusive(deps, buildSignalLease(), boardId)
  );
  if (outcome.kind === 'busy') {
    console.log('  Een andere run is bezig op dit bord. Niets gedaan.\n');
    return;
  }
  const report = outcome.report;

  if (report.findings.length === 0) {
    console.log('  Niets gevonden.\n');
  }
  for (const finding of report.findings) {
    console.log(`  ${finding.kind.padEnd(22)} ${findingName(finding)}`);
  }

  console.log(`\n${report.summary}\n`);
  // In een droogloop zijn dit voornemens, in een echte run uitgevoerde acties. Zelfde
  // getallen; alleen het woord ervoor verschilt, zodat de regel niet doet alsof.
  console.log(
    `  ${apply ? 'uitgevoerd' : 'zou doen'} —` +
      `  nieuw: ${report.created}   bijgewerkt: ${report.updated}` +
      `   heropend: ${report.reopened}   afgevinkt: ${report.resolved}` +
      `   verplaatst: ${report.moved}`
  );

  if (report.failures.length > 0) {
    console.log('\n  MISLUKTE CONTROLES:');
    for (const failure of report.failures) {
      console.log(`     ${failure.check}: ${failure.error}`);
    }
  }

  if (!apply) {
    console.log('\n  Droogloop. Voer uit met --apply om het echt weg te schrijven.\n');
  } else {
    console.log('');
  }

  if (report.failures.length > 0) {
    process.exit(EXIT_FAILURE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
