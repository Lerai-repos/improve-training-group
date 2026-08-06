import { describe, expect, it } from 'vitest';

import { keyShape, parseWebhook, type WebhookRouting } from '../event';

const routing: WebhookRouting = {
  inplannenGroupIds: ['inplannen', 'herplannen'],
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

  // "Herplannen / Inplannen" is where a training goes to be REplanned, which is
  // exactly when its recommendations must be recomputed. Its Monday id is the
  // default `nieuwe_groep` and its title is confusingly close to "Inplannen" —
  // a real drag once landed there and looked like a dead webhook.
  it('routes a move into the SECOND trigger group as group_move too', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 7,
          groupId: 'herplannen',
          originalTriggerUuid: 'u9',
        },
      },
      routing
    );
    expect(p).toEqual({
      kind: 'trigger',
      triggerUuid: 'u9',
      triggerKind: 'group_move',
      mondayItemId: '7',
    });
  });

  it('a group outside the configured set is still ignored', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 7,
          groupId: 'nieuwe_orders',
          originalTriggerUuid: 'u9',
        },
      },
      routing
    );
    expect(p).toEqual({ kind: 'ignore', reason: 'group move not into a trigger group' });
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

/**
 * The field names in `event.ts` are provisional until the first real payload is
 * captured. These cases pin the behaviour that makes that capture safe: a routing
 * field we cannot READ is drift (malformed → 422 → Monday retries → logged with the
 * real field names), never a 200 that silently swallows a trigger.
 */
describe('parseWebhook field-name drift', () => {
  it('a move event with an unreadable group id is malformed, not ignored', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'move_pulse_into_group',
          pulseId: 42,
          // Monday actually calls it something else → neither name resolves.
          targetGroupId: 'inplannen',
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('malformed');
    expect(p).toMatchObject({ keys: expect.arrayContaining(['targetGroupId']) });
  });

  it('a column event with an unreadable column id is malformed, not ignored', () => {
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnUuid: 'color_x',
          value: { label: { text: 'RUN' } },
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('malformed');
  });

  it('a status change on our column with an unreadable label is malformed', () => {
    // A drifted value shape would otherwise read as "status not RUN" and drop the click.
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_x',
          value: { labelText: 'RUN' },
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('malformed');
  });

  // Monday clears a column with `null` or `{}`, and the label may be explicitly
  // null. 422-ing these would make Monday retry a legitimate user action — someone
  // clearing the status — until it disabled the subscription.
  it.each([
    ['null', null],
    ['an empty object', {}],
    ['an explicitly null label', { label: null }],
  ])('a CLEARED status (%s) stays an ignore, never a 422', (_name, value) => {
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_x',
          value,
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('ignore');
  });

  it.each([
    ['an empty array', []],
    ['a populated array', [{ label: { text: 'RUN' } }]],
  ])('a status value of %s is drift, not a clear', (_name, value) => {
    // Monday clears with null or `{}`, never `[]` — but `Object.keys([])` is empty
    // too, so an array must not fall into the cleared branch and be acknowledged.
    const p = parseWebhook(
      {
        event: {
          type: 'update_column_value',
          pulseId: 7,
          columnId: 'color_x',
          value,
          originalTriggerUuid: 'u1',
        },
      },
      routing
    );
    expect(p.kind).toBe('malformed');
  });

  it('keyShape reports field NAMES only — never values (they carry PII)', () => {
    const shape = keyShape({
      event: {
        type: 'update_column_value',
        pulseId: 7,
        value: { label: { text: 'RUN' } },
        userId: 123,
      },
    });
    expect(shape).toEqual([
      'pulseId',
      'type',
      'userId',
      'value',
      'value.label',
      'value.label.text',
    ]);
    expect(JSON.stringify(shape)).not.toContain('RUN');
    expect(JSON.stringify(shape)).not.toContain('123');
  });

  it('keyShape distinguishes value.label.text from a renamed value.label.name', () => {
    // Stopping at `value.label` would report both shapes identically, hiding the
    // exact drift the diagnostic exists to reveal.
    const current = keyShape({ event: { value: { label: { text: 'RUN' } } } });
    const drifted = keyShape({ event: { value: { label: { name: 'RUN' } } } });
    expect(current).toContain('value.label.text');
    expect(drifted).toContain('value.label.name');
    expect(current).not.toEqual(drifted);
  });

  it('keyShape collapses arrays instead of emitting every index', () => {
    const shape = keyShape({ event: { value: { linkedPulseIds: [1, 2, 3] } } });
    expect(shape).toEqual(['value', 'value.linkedPulseIds', 'value.linkedPulseIds[]']);
  });
});
