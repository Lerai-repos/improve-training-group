/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION, TRAINERS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { INSTELLINGEN_PRODUCTION, loadSettingsOnce } from '@lib/settings';
import {
  assertSettingsMatchTarget,
  cohortEuros,
  provisionTarief,
  tariefKeyPrefix,
} from '@lib/trainers';

/**
 * Add `Uurtarief` and `Datum instroom` to the Trainers board, and seed the rate for the
 * trainers whose group still records which cohort they are on.
 *
 *   pnpm trainers:tarief              # dry run — prints every column and value
 *   pnpm trainers:tarief --apply
 *
 * ## Run this BEFORE deploying the reader, and before ITG reorganises the groups
 *
 * The engine's strict column list gains `itg_uurtarief`, so deploying first would FOUT
 * every training until the column exists. And the seed can only be derived while the two
 * `Trainers instroom …` groups are still intact — after the reorg nothing on the board
 * records who is on which rate, and the three `Tariefconstructie` columns cover barely a
 * third of the roster.
 *
 * ## The amount comes from Instellingen, never from a constant
 *
 * `88` and `84` are what the code shipped with, but the board owns those numbers now. The
 * cohort rates are read through the same loader the engine uses, so this writes today's
 * effective rate and the migration changes only where the rate comes from.
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  console.log(apply ? 'APPLY — writing to Monday\n' : 'DRY RUN — nothing is written\n');
  console.log(`Trainersbord: ${TRAINERS_BOARD}`);

  // Today's effective cohort rates, read through the engine's own settings loader.
  const settings = await loadSettingsOnce(read);

  assertSettingsMatchTarget({
    settingsBoardId: settings.boardId,
    productionSettingsBoardId: INSTELLINGEN_PRODUCTION.boardId,
    targetBoardId: TRAINERS_BOARD,
  });

  const today = new Date().toISOString().slice(0, 10);
  const euroByGroup = cohortEuros(settings.rateCards, today);

  console.log(`Cohorttarieven (${today}):`);
  for (const [groupId, euros] of euroByGroup) {
    console.log(`  ${groupId.padEnd(20)} € ${euros}/uur`);
  }
  console.log('');

  const result = await provisionTarief({
    read,
    write,
    boardId: TRAINERS_BOARD,
    keyPrefix: tariefKeyPrefix(TRAINERS_BOARD),
    apply,
    euroByGroup,
    log: (line) => console.log(`  ${line}`),
  });

  console.log('');
  if (result.createdColumns.length > 0) {
    console.log(`Kolommen ${apply ? 'aangemaakt' : 'aan te maken'}:`);
    result.createdColumns.forEach((c) => console.log(`  + ${c}`));
  } else {
    console.log('Kolommen stonden er al.');
  }

  const { plan } = result;
  console.log(`\n${plan.writes.length} tarieven ${apply ? 'geschreven' : 'te schrijven'}:`);
  const byGroup = new Map<string, { count: number; euros: string }>();
  for (const w of plan.writes) {
    const cur = byGroup.get(w.groupTitle) ?? { count: 0, euros: w.euros };
    byGroup.set(w.groupTitle, { count: cur.count + 1, euros: w.euros });
  }
  for (const [title, { count, euros }] of byGroup) {
    console.log(`  ${title.padEnd(34)} ${String(count).padStart(4)} × € ${euros}`);
  }

  if (plan.alreadySet.length > 0) {
    console.log(`\n${plan.alreadySet.length} al ingevuld — met rust gelaten:`);
    for (const a of plan.alreadySet) {
      console.log(`  ${a.naam.padEnd(28)} € ${a.current}`);
    }
  }

  const skipped = plan.noCohort.reduce((n, g) => n + g.count, 0);
  console.log(`\n${skipped} trainers zonder af te leiden cohort — blijven leeg:`);
  for (const g of plan.noCohort) {
    console.log(`  ${g.groupTitle.padEnd(34)} ${String(g.count).padStart(4)}`);
  }
  console.log(
    '\nDat is geen probleem: die groepen staan niet in de aanbevelingsselectie, dus die\n' +
      'trainers worden sowieso niet aanbevolen. Willen jullie er later één inzetten, dan\n' +
      'vult ITG het tarief met de hand in.'
  );

  if (!apply) {
    console.log('\nDry run klaar. Draai opnieuw met --apply om dit echt te doen.');
    return;
  }

  console.log(`\n✓ ${result.written} tarieven geschreven en teruggelezen.`);
  console.log(
    'Volgende stap: deploy de code die itg_uurtarief leest. Nu de kolom bestaat, kan die\n' +
      'deploy niets breken.'
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(EXIT_FAILURE);
});
