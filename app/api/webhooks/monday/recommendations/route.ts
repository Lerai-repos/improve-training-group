import { NextResponse } from 'next/server';

import {
  buildQueueDeps,
  handleParsedWebhook,
  parseWebhook,
  verifyWebhookToken,
  webhookRouting,
} from '@lib/recommend';

export const runtime = 'nodejs';

// POST /api/webhooks/monday/recommendations?token=… — Monday webhook (challenge + events).
//
// Authentication comes BEFORE the challenge echo. Monday's JWT is absent on the
// challenge request, which is why the docs tell you to answer it first — but the
// shared secret rides on the URL, so it is present here too and there is no reason
// to answer an unauthenticated caller at all.
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyWebhookToken(request.url, process.env.MONDAY_WEBHOOK_TOKEN)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parse = parseWebhook(body, webhookRouting());
  // No opportunistic drain: QStash owns delivery, so the only job here is to record
  // the trigger durably and hand it over.
  const result = await handleParsedWebhook(buildQueueDeps().queue, parse);
  return NextResponse.json(result.body, { status: result.status });
}
