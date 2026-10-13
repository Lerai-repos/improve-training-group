/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

/**
 * De twee webhooks op het Opportunitybord voor de inventarisatielink: een nieuwe Opportunity, en
 * een ander label.
 *
 *   pnpm inventarisatie:webhook            # droogloop: laat zien wat er staat en wat erbij zou komen
 *   pnpm inventarisatie:webhook --apply
 *
 * **Pas NA de deploy draaien**: Monday roept bij het aanmaken meteen de route aan (de challenge),
 * en zonder route mislukt het aanmaken. `PUBLIC_BASE_URL` moet de productie-URL zijn.
 *
 * **Eén keer draaien.** Het Opportunitybord is vast, anders dan de agendaborden die elk jaar een
 * kopie krijgen. Er staat al een `create_item`-webhook onder dezelfde Monday-gebruiker (n8n of
 * Make.com), en Monday geeft de URL van een webhook niet terug, dus "bestaat al" is niet te
 * onderscheiden van "is van een ander". Daarom maakt `--apply` altijd beide aan. Twee keer
 * draaien geeft dubbele events: onschuldig, want de sync schrijft alleen verschillen.
 */

const EXIT_FAILURE = 1;

interface Webhook {
  readonly id: string;
  readonly event: string;
  readonly config: string | null;
}

const GEWENST = [
  { event: 'create_item', config: null },
  {
    event: 'change_specific_column_value',
    config: JSON.stringify({ columnId: OPPORTUNITY_COLUMNS.label }),
  },
] as const;

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

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const data = await read.query<{ webhooks?: Webhook[] | null }>(
    'query ($b: ID!) { webhooks(board_id: $b, app_webhooks_only: false) { id event config } }',
    { b: OPPORTUNITY_BOARD }
  );

  console.log(`\nInventarisatie-webhooks op het Opportunitybord — ${apply ? 'APPLY' : 'droogloop'}\n`);
  console.log('  staan er nu (van wie dan ook):');
  for (const w of data.webhooks ?? []) {
    console.log(`     ${w.id}  ${w.event}  ${w.config ?? ''}`);
  }
  console.log('');
  for (const { event, config } of GEWENST) {
    if (!apply) {
      console.log(`  zou aanmaken: ${event}${config === null ? '' : ` ${config}`}`);
      continue;
    }
    const made = await write.mutate<{ create_webhook: { id: string } }>(
      `mutation ($b: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
         create_webhook(board_id: $b, url: $url, event: $event, config: $config) { id }
       }`,
      {
        b: OPPORTUNITY_BOARD,
        url: `${base}/api/webhooks/monday/inventarisatie?token=${geheim}`,
        event,
        config,
      },
      { idempotencyKey: `inventarisatie-webhook:${OPPORTUNITY_BOARD}:${event}` }
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
