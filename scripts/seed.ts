/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

// tsx does not auto-load .env.local (Next does). Load it before reading env.
loadEnv({ path: '.env.local' });

import { createAdminSupabaseClient } from '@lib/db/admin';
import { assertNonProdTarget, resolveAdminDbUrl } from '@lib/db/target';
import { createMockMondayPort } from '@lib/monday';
import { syncPlanningFromMonday } from '@lib/sync';

const AGENDA_BOARD_ID = '5087396949';

async function main(): Promise<void> {
  // The seed drives the SAME reconciling RPC as a real sync: the 2-row mock would
  // tombstone nearly every Monday-sourced record on a populated board. Refuse any
  // non-local target so `pnpm seed` can never run against a real environment.
  const dbUrl = resolveAdminDbUrl();
  assertNonProdTarget(dbUrl);
  console.log(`Seeding mock data → ${dbUrl}`);

  const admin = createAdminSupabaseClient();
  const monday = createMockMondayPort();

  const result = await syncPlanningFromMonday(admin, monday, {
    boardId: AGENDA_BOARD_ID,
  });

  console.log('Seed complete:', result);
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
