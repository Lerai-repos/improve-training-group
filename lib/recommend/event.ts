import { z } from 'zod';

/**
 * Parse + route a Monday webhook body. Distinguishes the challenge handshake, the
 * two real triggers (group-move into Inplannen, the RUN button), and everything
 * else (ignored). The LOOP GUARD lives here: only a RUN value on the status column
 * re-triggers, so the engine's own GEREED/GEEN MATCH/FOUT writes never re-fire.
 *
 * NOTE: field names (groupId/destGroupId, value.label.text, originalTriggerUuid)
 * are provisional until Phase-6 payload capture confirms the real shapes.
 */

const statusValueSchema = z.object({ label: z.object({ text: z.string() }).nullish() }).nullish();

const eventSchema = z.object({
  type: z.string(),
  pulseId: z.union([z.number(), z.string()]).optional(),
  boardId: z.union([z.number(), z.string()]).optional(),
  groupId: z.string().optional(),
  destGroupId: z.string().optional(),
  columnId: z.string().optional(),
  value: z.unknown().optional(),
  // Real payloads send `originalTriggerUuid: null` and carry the id in `triggerUuid`;
  // `.nullish()` accepts null so the whole body isn't rejected as unparseable.
  originalTriggerUuid: z.string().nullish(),
  triggerUuid: z.string().nullish(),
});

const bodySchema = z.object({
  challenge: z.string().optional(),
  event: eventSchema.optional(),
});

export type TriggerKind = 'group_move' | 'manual_button';

export type WebhookParse =
  | { kind: 'challenge'; challenge: string }
  | {
      kind: 'trigger';
      triggerUuid: string;
      triggerKind: TriggerKind;
      mondayItemId: string;
    }
  // An event that IS one of our trigger types but can't be acted on (missing
  // identity, unparseable body). Must be surfaced as a retryable error, NOT
  // acknowledged with 200 — otherwise a field/schema drift silently drops triggers.
  | { kind: 'malformed'; reason: string }
  | { kind: 'ignore'; reason: string };

export interface WebhookRouting {
  inplannenGroupId: string;
  statusColumnId: string;
  runLabel: string;
}

const MOVE_TYPES = new Set(['move_pulse_into_group', 'item_moved_to_specific_group']);
const COLUMN_TYPES = new Set([
  'update_column_value',
  'change_column_value',
  'change_status_column_value',
  'change_specific_column_value',
]);

function statusLabelText(value: unknown): string | null {
  const parsed = statusValueSchema.safeParse(value);
  if (parsed.success && parsed.data && parsed.data.label) {
    return parsed.data.label.text;
  }
  return null;
}

export function parseWebhook(body: unknown, routing: WebhookRouting): WebhookParse {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    // Reaches the handler only after signature verification, so an unparseable
    // body here is an AUTHENTIC Monday event we failed to model → retry, not drop.
    return { kind: 'malformed', reason: 'unparseable body' };
  }
  if (typeof parsed.data.challenge === 'string') {
    return { kind: 'challenge', challenge: parsed.data.challenge };
  }
  const event = parsed.data.event;
  if (!event) {
    return { kind: 'ignore', reason: 'no event or challenge' };
  }

  const isMove = MOVE_TYPES.has(event.type);
  const isColumn = COLUMN_TYPES.has(event.type);
  // Not one of our trigger types → genuinely nothing to do (ack with 200).
  if (!isMove && !isColumn) {
    return { kind: 'ignore', reason: `unhandled event type ${event.type}` };
  }

  // A trigger-type event missing its identity fields is malformed (retryable),
  // never a silent 200 — losing it would drop a real trigger with no trace.
  const triggerUuid = event.originalTriggerUuid ?? event.triggerUuid;
  if (!triggerUuid) {
    return { kind: 'malformed', reason: `${event.type} missing trigger uuid` };
  }
  const mondayItemId = event.pulseId === undefined ? null : String(event.pulseId);
  if (!mondayItemId) {
    return { kind: 'malformed', reason: `${event.type} missing pulseId` };
  }

  if (isMove) {
    const dest = event.groupId ?? event.destGroupId;
    if (dest === routing.inplannenGroupId) {
      return { kind: 'trigger', triggerUuid, triggerKind: 'group_move', mondayItemId };
    }
    return { kind: 'ignore', reason: 'group move not into Inplannen' };
  }

  if (event.columnId !== routing.statusColumnId) {
    return { kind: 'ignore', reason: 'column update on a non-status column' };
  }
  if (statusLabelText(event.value) !== routing.runLabel) {
    // Only RUN re-triggers — our own terminal writes are ignored (loop guard).
    return { kind: 'ignore', reason: 'status not RUN' };
  }
  return { kind: 'trigger', triggerUuid, triggerKind: 'manual_button', mondayItemId };
}
