/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  agendaBoardId,
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

const MONDAY_URL = 'https://api.monday.com/v2';

/**
 * Raw transport for the two webhook mutations.
 *
 * `createMondayGraphQLClient` is a read-only port: it rejects any document containing
 * `mutation` before it leaves the process, so it cannot carry these. Rather than
 * weaken that guard, this script brings its own POST — exactly what `monday-status.ts`
 * does for the status write. Keeping it here rather than in `lib/` also keeps the
 * invariant that the DEPLOYED app's only Monday write is the status label; registering
 * a webhook is an operator action, run by hand.
 */
async function mutate<T>(document: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: {
      Authorization: requireEnv('MONDAY_API_TOKEN'),
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query: document, variables }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Monday API ${res.status}: ${raw}`);
  }
  // GraphQL errors arrive as HTTP 200 with an `errors[]` body. A failed challenge
  // handshake — our own route answering 401 — surfaces here, not as a bad status.
  const body: { data?: T; errors?: Array<{ message: string }> } = JSON.parse(raw);
  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  if (!body.data) {
    throw new Error('Monday GraphQL: empty data');
  }
  return body.data;
}

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
    { board: agendaBoardId() }
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
      const res = await mutate<{ create_webhook: { id: string; event: string } | null }>(
        `mutation ($board: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
           create_webhook(board_id: $board, url: $url, event: $event, config: $config) { id event }
         }`,
        {
          board: agendaBoardId(),
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

async function remove(ids: string[]): Promise<void> {
  for (const id of ids) {
    const res = await mutate<{ delete_webhook: { id: string } | null }>(
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
    await remove(rest);
  }

  const rows = await list(c);
  console.log(`\nWebhooks on Agenda 2026 (${agendaBoardId()}):`);
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
