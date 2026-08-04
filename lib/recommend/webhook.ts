import { log } from '@lib/logger';

import type { WebhookParse } from './event';

/**
 * HTTP status for an authentic-but-unmodellable trigger payload. Monday retries a
 * non-2xx once a minute for 30 MINUTES ONLY, so this buys a window to ship a schema
 * fix and have the original trigger replay itself — not an open-ended guarantee.
 * Past it the event is gone and has to be re-triggered by hand (see docs/m2b §7).
 * https://developer.monday.com/api-reference/reference/webhooks#retry-policy
 */
const MALFORMED_STATUS = 422;

/**
 * Durable enqueue of a triggered run. NOT IMPLEMENTED in this pass — the Postgres
 * queue (dedup on trigger_uuid, per-training generation, lease + fencing) was
 * deleted with the database, and the KV replacement lands next pass. The port
 * exists now so the handler and its tests keep their shape.
 */
export interface RunQueue {
  enqueue(input: {
    triggerUuid: string;
    triggerKind: 'group_move' | 'manual_button';
    mondayItemId: string;
  }): Promise<void>;
}

/** The HTTP shape a route returns for a parsed webhook. */
export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle a parsed webhook: echo the challenge, no-op an ignored event, or
 * synchronously enqueue a run BEFORE the 200 (durability). An enqueue failure
 * returns a non-2xx so Monday retries the delivery. A malformed trigger payload
 * (authentic event we can't act on) also returns a retryable non-2xx and is
 * logged, so a schema/field drift surfaces loudly instead of dropping triggers.
 */
export async function handleParsedWebhook(
  queue: RunQueue,
  parse: WebhookParse
): Promise<WebhookResult> {
  if (parse.kind === 'challenge') {
    return { status: 200, body: { challenge: parse.challenge } };
  }
  if (parse.kind === 'malformed') {
    // `keys` is field NAMES only (no values → no PII). It is the whole point of
    // this branch: the first real payload tells us which name drifted.
    log.error('monday webhook: malformed trigger payload', {
      reason: parse.reason,
      keys: parse.keys,
    });
    return { status: MALFORMED_STATUS, body: { error: 'malformed payload', reason: parse.reason } };
  }
  if (parse.kind === 'ignore') {
    log.debug('monday webhook: ignored event', { reason: parse.reason });
    return { status: 200, body: { ignored: parse.reason } };
  }
  try {
    await queue.enqueue({
      triggerUuid: parse.triggerUuid,
      triggerKind: parse.triggerKind,
      mondayItemId: parse.mondayItemId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { error: message } };
  }
  return { status: 200, body: { enqueued: true } };
}
