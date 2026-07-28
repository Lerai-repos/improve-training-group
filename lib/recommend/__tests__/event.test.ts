import { describe, expect, it } from 'vitest';

import { parseWebhook, type WebhookRouting } from '../event';

const routing: WebhookRouting = {
  inplannenGroupId: 'inplannen',
  statusColumnId: 'color_x',
  runLabel: 'RUN',
};

describe('parseWebhook', () => {
  it('detects the challenge handshake', () => {
    expect(parseWebhook({ challenge: 'abc123' }, routing)).toEqual({
      kind: 'challenge',
      challenge: 'abc123',
    });
  });

  it('routes a move into Inplannen as group_move', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          groupId: 'inplannen',
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p).toEqual({
      kind: 'trigger',
      triggerKind: 'group_move',
      mondayItemId: '42',
      triggerUuid: 'u1',
    });
  });

  it('ignores a move into a different group', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          groupId: 'februari',
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('ignore');
  });

  it('routes a RUN value on the status column as manual_button', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_x',
          value: { label: { text: 'RUN' } },
          originalTriggerUuid: 'u2',
        },
      },
      routing
    );
    expect(p).toEqual({
      kind: 'trigger',
      triggerKind: 'manual_button',
      mondayItemId: '7',
      triggerUuid: 'u2',
    });
  });

  it('LOOP GUARD: ignores our own terminal writes (GEREED) on the status column', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_x',
          value: { label: { text: 'GEREED' } },
          originalTriggerUuid: 'u3',
        },
      },
      routing
    );
    expect(p.kind).toBe('ignore');
  });

  it('ignores a column update on a non-status column', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'other',
          value: { label: { text: 'RUN' } },
          originalTriggerUuid: 'u4',
        },
      },
      routing
    );
    expect(p.kind).toBe('ignore');
  });

  it('accepts the real payload shape: originalTriggerUuid null, id in triggerUuid', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          groupId: 'inplannen',
          originalTriggerUuid: null,
          triggerUuid: 't9',
        },
      },
      routing
    );
    expect(p).toEqual({
      kind: 'trigger',
      triggerKind: 'group_move',
      mondayItemId: '42',
      triggerUuid: 't9',
    });
  });

  it('flags a trigger event missing its trigger uuid as malformed (retryable, not dropped)', () => {
    const p = parseWebhook(
      { event: { type: 'move_pulse_into_group', pulseId: 42, groupId: 'inplannen' } },
      routing
    );
    expect(p.kind).toBe('malformed');
  });

  it('flags a trigger event missing its pulseId as malformed', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          groupId: 'inplannen',
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('malformed');
  });

  it('ignores (200) a non-trigger event type even without identity fields', () => {
    const p = parseWebhook({ event: { type: 'some_other_event' } }, routing);
    expect(p.kind).toBe('ignore');
  });
});
