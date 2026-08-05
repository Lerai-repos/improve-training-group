/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  AGENDA_2026_BOARD,
  INPLANNEN_GROUP_ID,
  MONDAY_API_VERSION,
  RECOMMENDATION_STATUS_COLUMN,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * Register / list / delete the two Monday webhooks that trigger a recommendation run.
 *
 *   pnpm webhook:list
 *   pnpm webhook:register
 *   pnpm webhook:delete <id> [<id> …]
 *
 * The ONLY mutation this project makes to Monday besides the status write, so it is a
 * separate deliberate command rather than something a deploy does implicitly.
 *
 * Registration triggers Monday's challenge handshake immediately: it POSTs
 * `{"challenge": "..."}` to the URL and requires the same value echoed back, so a
 * wrong URL or a mismatched token fails here rather than silently later.
 */

interface WebhookRow {
  id: string;
  event: string;
  board_id: string;
  config: string | null;
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function webhookUrl(): string {
  const base = requireEnv('PUBLIC_BASE_URL').replace(/\/$/, '');
  // The shared secret rides on the URL — it is what authenticates every delivery,
  // including the challenge.
  return `${base}/api/webhooks/monday/recommendations?token=${requireEnv('MONDAY_WEBHOOK_TOKEN')}`;
}

/** Never print the token — the URL is echoed back by Monday and ends up in logs. */
function redact(url: string): string {
  return url.replace(/token=[^&]*/, 'token=***');
}

/**
 * ONE subscription: a training arriving in Inplannen.
 *
 * We deliberately do NOT subscribe to n8n's status column. It was tempting, because the
 * Aanbevelingen button sets RUN there and that is the only manual trigger today — but
 * it would make one button press run both engines (double the Monday reads and provider
 * spend), it would deliver every n8n write back to us as an ignored event, and it would
 * tie our manual trigger to a column we intend to retire. n8n already has its own
 * group-move webhook, so a single drag still exercises both systems on identical input,
 * which was the real reason to want it.
 *
 * Manual re-run belongs in the recommendations view instead, where a button can call
 * our API directly. Until that exists, use `pnpm recommend:enqueue <itemId>`.
 */
const TARGETS = [
  {
    label: 'group move into Inplannen',
    event: 'item_moved_to_specific_group',
    config: { groupId: process.env.MONDAY_INPLANNEN_GROUP_ID || INPLANNEN_GROUP_ID },
  },
] as const;

type Client = ReturnType<typeof createMondayGraphQLClient>;

function client(): Client {
  return createMondayGraphQLClient({
    token: requireEnv('MONDAY_API_TOKEN'),
    apiVersion: MONDAY_API_VERSION,
  });
}

async function list(c: Client): Promise<WebhookRow[]> {
  const res = await c.query<{ webhooks: WebhookRow[] | null }>(
    `query ($board: ID!) { webhooks(board_id: $board) { id event board_id config } }`,
    { board: AGENDA_2026_BOARD }
  );
  return res.webhooks ?? [];
}

async function register(c: Client): Promise<void> {
  const url = webhookUrl();
  console.log(`\nRegistering against ${redact(url)}\n`);

  // NO automatic dedup: Monday's `webhooks` query returns id/event/config but NOT the
  // url, so ours is indistinguishable from n8n's — and n8n already listens to both of
  // these events on this board. Skipping on a matching event would therefore skip
  // every time and register nothing at all. Re-running this DOES create duplicates;
  // record the ids it prints and use `webhook:delete` to undo.
  const existing = await list(c);
  for (const target of TARGETS) {
    const clashes = existing.filter((w) => w.event === target.event);
    if (clashes.length > 0) {
      console.log(
        `    note: ${clashes.length} existing webhook(s) for ${target.event} (id ${clashes
          .map((w) => w.id)
          .join(', ')}) — probably n8n's; adding ours alongside`
      );
    }
    try {
      const res = await c.query<{ create_webhook: { id: string; event: string } | null }>(
        `mutation ($board: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
           create_webhook(board_id: $board, url: $url, event: $event, config: $config) { id event }
         }`,
        {
          board: AGENDA_2026_BOARD,
          url,
          event: target.event,
          config: JSON.stringify(target.config),
        }
      );
      const created = res.create_webhook;
      console.log(
        created
          ? `  ✓ ${target.label}\n    id ${created.id}`
          : `  ✗ ${target.label}\n    Monday returned no webhook`
      );
    } catch (error) {
      // The challenge handshake runs inside this call, so a 401 from our own route
      // surfaces right here — usually a token mismatch or the wrong PUBLIC_BASE_URL.
      console.log(
        `  ✗ ${target.label}\n    ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function remove(c: Client, ids: string[]): Promise<void> {
  for (const id of ids) {
    const res = await c.query<{ delete_webhook: { id: string } | null }>(
      `mutation ($id: ID!) { delete_webhook(id: $id) { id } }`,
      { id }
    );
    console.log(res.delete_webhook ? `  ✓ deleted ${id}` : `  ✗ could not delete ${id}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const c = client();

  if (command === 'register') {
    await register(c);
  } else if (command === 'delete') {
    if (rest.length === 0) {
      throw new Error('delete needs at least one webhook id');
    }
    await remove(c, rest);
  }

  const rows = await list(c);
  console.log(`\nWebhooks on Agenda 2026 (${AGENDA_2026_BOARD}):`);
  if (rows.length === 0) {
    console.log('  (none)');
  }
  for (const w of rows) {
    console.log(`  ${w.id.padEnd(12)} ${w.event.padEnd(32)} ${w.config ?? ''}`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
