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
  // identity, unreadable routing field, unparseable body). Must be surfaced as a
  // retryable error, NOT acknowledged with 200 — otherwise a field/schema drift
  // silently drops triggers. `keys` carries the payload's field NAMES so the first
  // real event is self-diagnosing (see keyShape).
  | { kind: 'malformed'; reason: string; keys: readonly string[] }
  | { kind: 'ignore'; reason: string };

export interface WebhookRouting {
  /** Groups whose arrival triggers a run — "Inplannen" and "Herplannen / Inplannen". */
  inplannenGroupIds: readonly string[];
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

/**
 * Field NAMES of the event payload, descending into `value` — never the values.
 * Payload values carry client and trainer names (PII) and must not reach the logs;
 * the names alone are what a field-drift fix needs. Sorted so logs are diffable.
 */
export function keyShape(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const event = 'event' in body ? body.event : null;
  if (typeof event !== 'object' || event === null) {
    return Object.keys(body).sort();
  }
  const keys = Object.keys(event);
  const value = 'value' in event ? event.value : null;
  keys.push(...nestedKeys(value, 'value', 0));
  return keys.sort();
}

/** Levels of names emitted below `value` — enough to reach `value.label.text`. */
const MAX_KEY_DEPTH = 2;

/**
 * Paths of NAMES below `prefix`. The label lives at `value.label.text`, so stopping
 * at `value.label` would report the same shape whether the leaf is `text` or `name` —
 * i.e. it would hide the very drift this exists to reveal. Arrays collapse to `[]`
 * (indices carry no schema information and would bloat the line); depth is capped.
 */
function nestedKeys(value: unknown, prefix: string, depth: number): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return [`${prefix}[]`];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    out.push(path);
    if (depth < MAX_KEY_DEPTH) {
      out.push(...nestedKeys(child, path, depth + 1));
    }
  }
  return out;
}

/** A status column value: a readable label, a legitimate clear, or drift. */
type StatusValue = { kind: 'label'; text: string } | { kind: 'cleared' } | { kind: 'unreadable' };

/**
 * Monday clears a column with `null` OR an empty object, and the label itself may be
 * explicitly null — all three are a legitimate "status cleared", not schema drift.
 * Reporting them as malformed would 422 a benign user action, which Monday then
 * retries once a minute for 30 minutes — pure noise for an event we would never act on.
 * https://developer.monday.com/api-reference/docs/change-column-values#removing-column-values
 */
function readStatusValue(value: unknown): StatusValue {
  if (value === null) {
    return { kind: 'cleared' };
  }
  const parsed = statusValueSchema.safeParse(value);
  if (parsed.success && parsed.data) {
    if (parsed.data.label) {
      return { kind: 'label', text: parsed.data.label.text };
    }
    if (parsed.data.label === null) {
      return { kind: 'cleared' };
    }
  }
  // Plain objects only: `Object.keys([])` is also empty, so an array would otherwise
  // read as a clear and be acknowledged. Monday clears with null or `{}` — never `[]`,
  // so an array here is drift.
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return { kind: 'cleared' };
  }
  // Content we cannot read a label out of — a renamed field, not a clear.
  return { kind: 'unreadable' };
}

export function parseWebhook(body: unknown, routing: WebhookRouting): WebhookParse {
  const keys = keyShape(body);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    // Reaches the handler only after signature verification, so an unparseable
    // body here is an AUTHENTIC Monday event we failed to model → retry, not drop.
    return { kind: 'malformed', reason: 'unparseable body', keys };
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
    return { kind: 'malformed', reason: `${event.type} missing trigger uuid`, keys };
  }
  const mondayItemId = event.pulseId === undefined ? null : String(event.pulseId);
  if (!mondayItemId) {
    return { kind: 'malformed', reason: `${event.type} missing pulseId`, keys };
  }

  // A routing field we cannot READ AT ALL is field-name drift, not a non-match.
  // Treating it as an ignore would 200 the event and drop a real trigger with no
  // trace; malformed makes Monday retry and puts the real field names in the log.
  if (isMove) {
    const dest = event.groupId ?? event.destGroupId;
    if (dest === undefined) {
      return { kind: 'malformed', reason: `${event.type} has no readable group id`, keys };
    }
    if (routing.inplannenGroupIds.includes(dest)) {
      return { kind: 'trigger', triggerUuid, triggerKind: 'group_move', mondayItemId };
    }
    return { kind: 'ignore', reason: 'group move not into a trigger group' };
  }

  if (event.columnId === undefined) {
    return { kind: 'malformed', reason: `${event.type} has no readable column id`, keys };
  }
  if (event.columnId !== routing.statusColumnId) {
    return { kind: 'ignore', reason: 'column update on a non-status column' };
  }
  const status = readStatusValue(event.value);
  if (status.kind === 'unreadable') {
    // A status change on OUR column carrying content we cannot read a label from:
    // the value shape drifted. Ignoring it would drop a RUN click silently.
    return { kind: 'malformed', reason: `${event.type} has no readable status label`, keys };
  }
  if (status.kind === 'cleared') {
    return { kind: 'ignore', reason: 'status cleared' };
  }
  if (status.text !== routing.runLabel) {
    // Only RUN re-triggers — our own terminal writes are ignored (loop guard).
    return { kind: 'ignore', reason: 'status not RUN' };
  }
  return { kind: 'trigger', triggerUuid, triggerKind: 'manual_button', mondayItemId };
}
