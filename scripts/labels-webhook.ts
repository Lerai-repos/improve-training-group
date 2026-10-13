/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { labelsBoardId } from '@lib/labels';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

/**
 * De webhooks op het Labels-bord, zodat een nieuw label meteen in de keuzelijsten komt.
 *
 *   pnpm labels:webhook            # droogloop: wat er staat en wat erbij zou komen
 *   pnpm labels:webhook --apply
 *
 * Drie events: een rij erbij, een andere naam, en een kolomwijziging (een label telt pas mee als
 * zijn volledige naam er staat, zie `leesGewensteLabels`).
 *
 * **Pas NA de deploy draaien**: Monday roept bij het aanmaken meteen de route aan (de challenge).
 * `PUBLIC_BASE_URL` moet de productie-URL zijn.
 *
 * Het Labels-bord is van ons alleen, dus een event dat er al staat is van ons en wordt niet nog
 * eens aangemaakt. Opnieuw draaien is daarmee onschuldig.
 */

const EXIT_FAILURE = 1;

const EVENTS = ['create_item', 'change_name', 'change_column_value'] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN ontbreekt');
  }
  const base = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  const geheim = (process.env.MONDAY_WEBHOOK_TOKEN ?? '').trim();
  if (apply && (base === '' || geheim === '')) {
    throw new Error('PUBLIC_BASE_URL en MONDAY_WEBHOOK_TOKEN zijn nodig voor --apply.');
  }

  const boardId = labelsBoardId();
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const data = await read.query<{ webhooks?: Array<{ id: string; event: string }> | null }>(
    'query ($b: ID!) { webhooks(board_id: $b, app_webhooks_only: false) { id event } }',
    { b: boardId }
  );
  const bestaand = new Set((data.webhooks ?? []).map((w) => w.event));

  console.log(`\nWebhooks op het Labels-bord ${boardId} — ${apply ? 'APPLY' : 'droogloop'}\n`);
  for (const event of EVENTS) {
    if (bestaand.has(event)) {
      console.log(`  staat er al: ${event}`);
      continue;
    }
    if (!apply) {
      console.log(`  zou aanmaken: ${event}`);
      continue;
    }
    const made = await write.mutate<{ create_webhook: { id: string } }>(
      `mutation ($b: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook(board_id: $b, url: $url, event: $event) { id }
       }`,
      { b: boardId, url: `${base}/api/webhooks/monday/labels?token=${geheim}`, event },
      { idempotencyKey: `labels-webhook:${boardId}:${event}` }
    );
    // Nooit de URL printen: het geheim zit erin.
    console.log(`  aangemaakt: ${event} (${made.create_webhook.id})`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
