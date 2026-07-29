/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { getAppConfig } from '@lib/config';
import { createAdminSupabaseClient } from '@lib/db/admin';
import { MONDAY_API_VERSION, TRAINERS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildTrainerGroupReport,
  snapshotMaxAgeMs,
  unusableSelections,
  type TrainerGroupReadiness,
} from '@lib/recommend';

/**
 * List every Monday trainer group with a readiness verdict, marking which are
 * currently selected in `RECOMMENDABLE_TRAINER_GROUPS`.
 *
 * EXITS NON-ZERO when a SELECTED group is unusable — either it doesn't exist on the
 * board (typo/renamed/deleted) or it can never contribute a recommendation (nobody
 * green, or nobody priceable). Run this after changing the config; it's the
 * documented check that a selection actually does something.
 *
 *   pnpm groups:list
 */

const MARK: Record<TrainerGroupReadiness['status'], string> = {
  ready: 'OK  ',
  partial: 'WARN',
  not_configured: 'LEEG',
  missing_from_monday: 'FOUT',
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const admin = createAdminSupabaseClient();
  const cfg = await getAppConfig(admin);
  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  const report = await buildTrainerGroupReport({
    admin,
    reader: client,
    trainersBoardId: TRAINERS_BOARD,
    selected: cfg.recommendableTrainerGroups,
    maxAgeMs: snapshotMaxAgeMs(),
  });

  console.log(`Snapshot: sync ${report.syncRunId} (${report.syncStartedAt})`);
  console.log(`Rates resolved as of: ${report.refDate}\n`);
  console.log(
    `     ${pad('group id', 22)} ${pad('naam', 40)} ${pad('trainers', 9)} ${pad('groen', 6)} ${pad('prijsbaar', 10)} status`
  );

  for (const r of report.rows) {
    const sel = r.selected ? '[x]' : '[ ]';
    console.log(
      `${sel} ${MARK[r.status]} ${pad(r.id, 22)} ${pad(r.title ?? '(niet op het bord)', 40)} ${pad(
        String(r.trainers),
        9
      )} ${pad(String(r.greenTrainers), 6)} ${pad(String(r.greenWithResolvableRate), 10)} ${r.status}`
    );
  }

  const unusable = unusableSelections(report.rows);
  if (unusable.length > 0) {
    console.error(`\n${unusable.length} SELECTED group(s) contribute nothing:`);
    for (const r of unusable) {
      const why =
        r.status === 'missing_from_monday'
          ? 'not a group on the trainer board (typo, renamed, or deleted)'
          : `no priceable green trainers (${r.greenTrainers} green, ${r.greenWithoutRate} without a rate)`;
      console.error(`  - ${r.id}: ${why}`);
    }
    console.error('\nFix the RECOMMENDABLE_TRAINER_GROUPS config row, or configure those groups.');
    process.exit(1);
  }

  const partial = report.rows.filter((r) => r.selected && r.status === 'partial');
  for (const r of partial) {
    console.warn(
      `\nWARN ${r.id} (${r.title}): ${r.greenWithoutRate} green trainer(s) have no rate and will be skipped as no_rate.`
    );
  }
  console.log('\nAll selected groups are usable.');
}

main().catch((error) => {
  console.error('groups:list failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
