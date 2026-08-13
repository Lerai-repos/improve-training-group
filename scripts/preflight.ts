/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  AGENDA_2026_PRODUCTION_BOARD,
  agendaBoardId,
  MONDAY_API_VERSION,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { loadSettingsOnce } from '@lib/settings';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { createQStashClient } from '@lib/recommend/qstash';

/**
 * Is this environment actually wired up? Answers it by TALKING to each service, not
 * by checking that a variable is non-empty — a token can be present and wrong, which
 * is the failure that otherwise surfaces as a dead webhook or a silently 500ing cron.
 *
 * Never prints a secret's value, only whether it is set and whether it works.
 *
 *   pnpm preflight
 */

// `warn` does NOT fail the run: a test-board override is a legitimate state to be in,
// it just must never go unnoticed.
type Status = 'ok' | 'fail' | 'skip' | 'warn';
const results: Array<{ name: string; status: Status; detail: string }> = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
}

function present(...names: string[]): boolean {
  return names.every((n) => (process.env[n] ?? '').trim() !== '');
}

/** Either the Upstash names or Vercel's KV_* aliases — `createRedisClient` takes both. */
function redisConfigured(): boolean {
  return (
    present('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN') ||
    present('KV_REST_API_URL', 'KV_REST_API_TOKEN')
  );
}

async function checkMonday(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    record('Monday token', 'skip', 'MONDAY_API_TOKEN not set');
    return;
  }
  try {
    const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
    const pre = await client.preflight();
    record('Monday token', 'ok', `account ${pre.account.name ?? pre.account.id}`);
  } catch (error) {
    record('Monday token', 'fail', message(error));
  }
}

/**
 * The Instellingen board, read exactly as the engine reads it.
 *
 * This is deploy ①'s whole purpose: prove the board parses BEFORE the worker depends
 * on it. Reported values are the effective ones, so they can be compared line by line
 * against the env values they replace.
 */
async function checkInstellingen(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    record('Instellingen', 'skip', 'MONDAY_API_TOKEN not set');
    return;
  }
  try {
    const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
    const settings = await loadSettingsOnce(client);
    const { app } = settings;
    record('Instellingen', 'ok', `board ${settings.boardId}, fingerprint ${settings.fingerprint.slice(0, 12)}`);
    record(
      'Instellingen waarden',
      'ok',
      `HQ "${app.hqAddress}" · trainer ${app.travelRateTrainerCentsPerKm}c/km · ` +
        `klant ${app.travelRateClientCentsPerKm}c/km · drempel ${app.travelTimeThresholdMinutes}min · ` +
        `vergoeding ${app.travelTimeFeePerMinuteCents}c/min`
    );
    record(
      'Instellingen tarieven',
      'ok',
      settings.rateCards.map((c) => `${c.rateKey}=${c.hourlyRateCents}c`).join(' · ')
    );
  } catch (error) {
    // A refusal here is the point of the check, not an inconvenience: it is exactly
    // what the worker would have done, surfaced before the worker depends on it.
    record('Instellingen', 'fail', message(error));
  }
}

async function checkStatusColumn(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  const columnId = process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN;
  if (!token || !columnId) {
    record('Our status column', 'skip', 'token or MONDAY_RECOMMENDATION_STATUS_COLUMN not set');
    return;
  }
  try {
    const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
    const boardId = agendaBoardId();
    const [board] = await client.getSchema([boardId]);
    const column = board?.columns.find((c) => c.id === columnId);
    if (!column) {
      record('Our status column', 'fail', `${columnId} is not on board ${boardId}`);
      return;
    }
    const labels = column.settings_str ?? '';
    const missing = ['GEREED', 'GEEN MATCH', 'FOUT'].filter((l) => !labels.includes(l));
    record(
      'Our status column',
      missing.length === 0 ? 'ok' : 'fail',
      missing.length === 0 ? `${column.title} (${columnId})` : `missing label(s): ${missing.join(', ')}`
    );
    // The override is a silent no-op on production if it is forgotten — the engine
    // simply stops touching ITG's board — so preflight names the board every time
    // rather than only when something is wrong.
    const overridden = boardId !== AGENDA_2026_PRODUCTION_BOARD;
    record(
      'Agenda board',
      overridden ? 'warn' : 'ok',
      overridden
        ? `TEST OVERRIDE → ${board?.name ?? '?'} (${boardId}) via MONDAY_AGENDA_BOARD_ID — unset before going live`
        : `${board?.name ?? '?'} (${boardId})`
    );
  } catch (error) {
    record('Our status column', 'fail', message(error));
  }
}

async function checkRedis(): Promise<void> {
  if (!redisConfigured()) {
    record('Upstash Redis', 'skip', 'no UPSTASH_REDIS_REST_* or KV_REST_API_* credentials');
    return;
  }
  try {
    const kv = createUpstashKvStore(createRedisClient());
    const key = 'preflight:probe';
    await kv.set(key, 'ok', { ttlMs: 10_000 });
    const echoed = await kv.get(key);
    record(
      'Upstash Redis',
      echoed === 'ok' ? 'ok' : 'fail',
      echoed === 'ok' ? 'read/write round-trip' : `unexpected value: ${String(echoed)}`
    );
  } catch (error) {
    record('Upstash Redis', 'fail', message(error));
  }
}

async function checkRedisZset(): Promise<void> {
  if (!redisConfigured()) {
    record('Redis ZRANGE bound', 'skip', 'Redis not configured');
    return;
  }
  try {
    // Specifically exercises the '-inf' bound. Passing Number.NEGATIVE_INFINITY here
    // serializes to null over the REST API and errors, which is what silently broke
    // the publish-pending sweep — so probe it rather than trust it.
    const kv = createUpstashKvStore(createRedisClient());
    await kv.zadd('preflight:zset', 1, 'probe');
    const members = await kv.zRangeByScore('preflight:zset', 10, 5);
    await kv.zrem('preflight:zset', 'probe');
    record(
      'Redis ZRANGE bound',
      members.includes('probe') ? 'ok' : 'fail',
      members.includes('probe') ? "byscore with '-inf' works" : `got ${JSON.stringify(members)}`
    );
  } catch (error) {
    record('Redis ZRANGE bound', 'fail', message(error));
  }
}

async function checkQStash(): Promise<void> {
  if (!present('QSTASH_TOKEN')) {
    record('QStash token', 'skip', 'QSTASH_TOKEN not set');
    return;
  }
  try {
    // Deliberately the SAME constructor production uses, so this exercises the real
    // endpoint (regional accounts get a regional URL) rather than a default that
    // happens to work here and nowhere else.
    const client = createQStashClient();
    const schedules = await client.schedules.list();
    const endpoint = (process.env.QSTASH_URL ?? '').trim() || 'default endpoint';
    record('QStash token', 'ok', `${schedules.length} schedule(s) via ${endpoint}`);
  } catch (error) {
    record('QStash token', 'fail', message(error));
  }
}

function checkPlainVars(): void {
  const required: Array<[string, string]> = [
    ['MONDAY_WEBHOOK_TOKEN', 'webhook ?token= secret'],
    ['QSTASH_CURRENT_SIGNING_KEY', 'verifies QStash deliveries'],
    ['QSTASH_NEXT_SIGNING_KEY', 'verifies QStash deliveries during key rotation'],
    ['CRON_SECRET', 'guards the publish-pending sweep'],
    ['ADDRESS_HASH_KEY', 'keyed address fingerprints'],
    ['GOOGLE_MAPS_API_KEY', 'travel'],
    ['OPENROUTER_API_KEY', 'address cleanup'],
  ];
  for (const [name, why] of required) {
    record(name, present(name) ? 'ok' : 'fail', why);
  }
  // Falls back to VERCEL_URL in production, so locally-absent is only a warning.
  record(
    'PUBLIC_BASE_URL',
    present('PUBLIC_BASE_URL') ? 'ok' : 'skip',
    present('PUBLIC_BASE_URL') ? 'set' : 'unset — falls back to VERCEL_URL when deployed'
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  await checkMonday();
  await checkStatusColumn();
  await checkRedis();
  await checkInstellingen();
  await checkRedisZset();
  await checkQStash();
  checkPlainVars();

  const icon: Record<Status, string> = { ok: '✓', fail: '✗', skip: '·', warn: '!' };
  console.log('');
  for (const r of results) {
    console.log(`  ${icon[r.status]} ${r.name.padEnd(28)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  const suffix = warned.length === 0 ? '' : ` (${warned.length} warning(s))`;
  console.log(
    failed.length === 0
      ? `\nAll configured checks passed.${suffix}\n`
      : `\n${failed.length} check(s) failed.${suffix}\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(message(error));
  process.exit(1);
});
