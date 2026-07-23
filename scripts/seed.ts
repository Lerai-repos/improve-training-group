/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

// tsx does not auto-load .env.local (Next does). Load it before reading env.
loadEnv({ path: '.env.local' });

import { createAdminSupabaseClient } from '@lib/db/admin';
import { createMockMondayPort } from '@lib/monday';
import { syncPlanningFromMonday } from '@lib/sync';

const AGENDA_BOARD_ID = '5087396949';

async function main(): Promise<void> {
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
