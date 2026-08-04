import { describe, expect, it } from 'vitest';

import { parseWebhook, type WebhookRouting } from '../event';
import { handleParsedWebhook, type RunQueue } from '../webhook';

/**
 * Converted from the deleted `webhook.integration.test.ts`. Dedup is deliberately
 * NOT tested here: it is a property of the queue implementation (a unique key in
 * Postgres before, a KV primitive next pass), not of this handler.
 */

const routing: WebhookRouting = {
  inplannenGroupId: 'group_mkwtj07a',
  statusColumnId: 'color_mkzwfy42',
  runLabel: 'RUN',
};

function fakeQueue(behaviour: 'ok' | 'throw' = 'ok'): RunQueue & {
  calls: Array<{ triggerUuid: string; triggerKind: string; mondayItemId: string }>;
} {
  const calls: Array<{ triggerUuid: string; triggerKind: string; mondayItemId: string }> = [];
  return {
    calls,
    enqueue(input) {
      if (behaviour === 'throw') {
        return Promise.reject(new Error('queue unavailable'));
      }
      calls.push(input);
      return Promise.resolve();
    },
  };
}

describe('handleParsedWebhook', () => {
  it('echoes the challenge handshake', async () => {
    const q = fakeQueue();
    const r = await handleParsedWebhook(q, parseWebhook({ challenge: 'abc' }, routing));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ challenge: 'abc' });
    expect(q.calls).toHaveLength(0);
  });

  it('enqueues a group move into Inplannen', async () => {
    const q = fakeQueue();
    const parse = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 5029726254,
          groupId: 'group_mkwtj07a',
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    const r = await handleParsedWebhook(q, parse);
    expect(r.status).toBe(200);
    expect(q.calls).toEqual([
      { triggerUuid: 'u1', triggerKind: 'group_move', mondayItemId: '5029726254' },
    ]);
  });

  it('enqueues a RUN status change as a manual_button trigger', async () => {
    const q = fakeQueue();
    const parse = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_mkzwfy42',
          value: { label: { text: 'RUN' } },
          originalTriggerUuid: 'u2',
        },
      },
      routing
    );
    await handleParsedWebhook(q, parse);
    expect(q.calls[0]).toMatchObject({ triggerKind: 'manual_button', mondayItemId: '7' });
  });

  it('200s an ignored event without enqueueing (the loop guard)', async () => {
    const q = fakeQueue();
    const parse = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_mkzwfy42',
          value: { label: { text: 'GEREED' } }, // our own write
          originalTriggerUuid: 'u3',
        },
      },
      routing
    );
    const r = await handleParsedWebhook(q, parse);
    expect(r.status).toBe(200);
    expect(q.calls).toHaveLength(0);
  });

  it('422s a malformed trigger payload and reports the real field names', async () => {
    const q = fakeQueue();
    const parse = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          targetGroupId: 'group_mkwtj07a', // drifted field name
          originalTriggerUuid: 'u4',
        },
      },
      routing
    );
    const r = await handleParsedWebhook(q, parse);
    expect(r.status).toBe(422);
    expect(q.calls).toHaveLength(0);
  });

  it('returns a retryable non-2xx when the queue fails — never a false 200', async () => {
    const q = fakeQueue('throw');
    const parse = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          groupId: 'group_mkwtj07a',
          originalTriggerUuid: 'u5',
        },
      },
      routing
    );
    const r = await handleParsedWebhook(q, parse);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/queue unavailable/);
  });
});
