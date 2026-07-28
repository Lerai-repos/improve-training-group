import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '@lib/testing/supabase-clients';

import { parseWebhook, type WebhookRouting } from './event';
import { handleParsedWebhook } from './webhook';

const admin = adminClient();
const routing: WebhookRouting = {
  inplannenGroupId: 'inplannen',
  statusColumnId: 'color_x',
  runLabel: 'RUN',
};

async function clean(): Promise<void> {
  await admin.from('recommendation_runs').delete().gte('created_at', '1900-01-01');
  await admin.from('recommendation_generation').delete().neq('training_external_id', '');
}
beforeEach(clean);
afterEach(clean);

describe('handleParsedWebhook', () => {
  it('echoes the challenge', async () => {
    const res = await handleParsedWebhook(admin, parseWebhook({ challenge: 'xyz' }, routing));
    expect(res).toEqual({ status: 200, body: { challenge: 'xyz' } });
  });

  it('enqueues a run for a real trigger (durable, before the 200)', async () => {
    const parse = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 99,
          groupId: 'inplannen',
          originalTriggerUuid: 'trig-1',
        },
      },
      routing
    );
    const res = await handleParsedWebhook(admin, parse);
    expect(res.status).toBe(200);
    const { data } = await admin
      .from('recommendation_runs')
      .select('trigger_uuid, monday_item_id, trigger_kind, status')
      .eq('trigger_uuid', 'trig-1')
      .single();
    expect(data).toMatchObject({
      trigger_uuid: 'trig-1',
      monday_item_id: '99',
      trigger_kind: 'group_move',
      status: 'queued',
    });
  });

  it('dedups a retried delivery (same trigger uuid → one run)', async () => {
    const parse = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 99,
          groupId: 'inplannen',
          originalTriggerUuid: 'trig-2',
        },
      },
      routing
    );
    await handleParsedWebhook(admin, parse);
    await handleParsedWebhook(admin, parse);
    const { count } = await admin
      .from('recommendation_runs')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_uuid', 'trig-2');
    expect(count).toBe(1);
  });

  it('no-ops an ignored event', async () => {
    const res = await handleParsedWebhook(admin, { kind: 'ignore', reason: 'test' });
    expect(res).toEqual({ status: 200, body: { ignored: 'test' } });
  });
});
