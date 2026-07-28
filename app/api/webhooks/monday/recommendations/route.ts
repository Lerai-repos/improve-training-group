import { NextResponse } from 'next/server';

import { waitUntil } from '@vercel/functions';

import { createAdminSupabaseClient } from '@lib/db/admin';
import { log } from '@lib/logger';
import {
  buildWorkerDeps,
  drainOnce,
  handleParsedWebhook,
  parseWebhook,
  runWithDeadline,
  verifyMondaySignature,
  webhookRouting,
} from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Absolute deadline for the opportunistic drain's provider retries — 30s under
// maxDuration so a run finalizes (FOUT) before the function is killed.
const DRAIN_DEADLINE_MS = 270_000;

/** Kick the worker opportunistically after the 200 (the Cron drain is the durable path). */
async function drainSafely(): Promise<void> {
  try {
    const deps = await buildWorkerDeps();
    await runWithDeadline(Date.now() + DRAIN_DEADLINE_MS, () => drainOnce(deps));
  } catch (error) {
    log.error('recommendation drain failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// POST /api/webhooks/monday/recommendations — Monday webhook (challenge + events).
export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parse = parseWebhook(body, webhookRouting());
  // The setup challenge is answered without a signature (Monday sends it unsigned).
  if (parse.kind === 'challenge') {
    return NextResponse.json({ challenge: parse.challenge });
  }

  const secret = process.env.MONDAY_WEBHOOK_SIGNING_SECRET ?? '';
  if (!verifyMondaySignature(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();
  const result = await handleParsedWebhook(admin, parse);
  if (result.status === 200 && parse.kind === 'trigger') {
    waitUntil(drainSafely());
  }
  return NextResponse.json(result.body, { status: result.status });
}
