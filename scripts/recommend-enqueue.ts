/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { buildQueueDeps } from '@lib/recommend';

/**
 * Publish ONE recommendation job for a training, exactly as the webhook would.
 *
 *   pnpm recommend:enqueue <mondayItemId>
 *
 * This is how the queue gets validated without touching Monday's webhook config: it
 * runs the real `enqueueOrGet` and `markPublished` Lua against real Redis, publishes
 * through the real QStash endpoint, and the job is delivered to whatever
 * `PUBLIC_BASE_URL` points at — normally the deployed app.
 *
 * ⚠️ NOT read-only, unlike `recommend:once`. The job that this schedules WILL write a
 * status label to the training on the board.
 */

async function main(): Promise<void> {
  const mondayItemId = process.argv[2];
  if (!mondayItemId) {
    throw new Error('usage: pnpm recommend:enqueue <mondayItemId>');
  }

  const base = (process.env.PUBLIC_BASE_URL ?? '').trim();
  if (base === '') {
    throw new Error(
      'PUBLIC_BASE_URL is not set — the job would have nowhere to be delivered. ' +
        'Set it to the deployed URL (no trailing slash).'
    );
  }

  const { queue } = buildQueueDeps();
  // A fresh uuid each run, so every invocation is a genuinely new trigger rather than
  // a duplicate — the same thing Monday does per delivery.
  const triggerUuid = randomUUID();

  console.log(`\nEnqueueing ${mondayItemId}`);
  console.log(`  trigger  ${triggerUuid}`);
  console.log(`  target   ${base}/api/jobs/recommend`);

  const result = await queue.enqueue({
    triggerUuid,
    triggerKind: 'manual_button',
    mondayItemId,
  });

  if (result.accepted) {
    console.log(`\n✓ published, generation ${result.generation}`);
    console.log('  Watch: QStash console → Messages, then the status column on the board.\n');
  } else {
    console.log(`\n· not published: ${result.reason}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
