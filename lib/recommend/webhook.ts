import type { SupabaseClient } from '@supabase/supabase-js';

import { log } from '@lib/logger';
import type { Database } from '@lib/types/database';

import type { WebhookParse } from './event';

/** HTTP status for an authentic-but-unmodellable trigger payload (Monday retries non-2xx). */
const MALFORMED_STATUS = 422;

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
  admin: SupabaseClient<Database>,
  parse: WebhookParse
): Promise<WebhookResult> {
  if (parse.kind === 'challenge') {
    return { status: 200, body: { challenge: parse.challenge } };
  }
  if (parse.kind === 'malformed') {
    log.error('monday webhook: malformed trigger payload', { reason: parse.reason });
    return { status: MALFORMED_STATUS, body: { error: 'malformed payload', reason: parse.reason } };
  }
  if (parse.kind === 'ignore') {
    log.debug('monday webhook: ignored event', { reason: parse.reason });
    return { status: 200, body: { ignored: parse.reason } };
  }
  const { error } = await admin.rpc('enqueue_recommendation_run', {
    p_trigger_uuid: parse.triggerUuid,
    p_trigger_kind: parse.triggerKind,
    p_monday_item_id: parse.mondayItemId,
  });
  if (error) {
    return { status: 500, body: { error: error.message } };
  }
  return { status: 200, body: { enqueued: true } };
}
