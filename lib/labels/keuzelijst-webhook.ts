/**
 * De webhooks op het Labels-bord: een rij erbij, een andere naam, of een ingevulde kolom.
 *
 * Alle drie leiden tot dezelfde ronde over de keuzelijsten (`syncKeuzelijsten`), die zelf uitzoekt
 * wat er ontbreekt. Het Labels-bord is klein en van ons alleen, dus een ronde per wijziging kost
 * niets, en een event hoeft niet uitgeplozen te worden.
 */

export type LabelsWebhook =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'sync' }
  | { readonly kind: 'negeren'; readonly reden: string };

const EVENTS = new Set([
  'create_pulse',
  'create_item',
  'change_name',
  'update_name',
  'update_column_value',
  'change_column_value',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const alsId = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export function parseLabelsWebhook(body: unknown, labelsBoardId: string): LabelsWebhook {
  if (!isRecord(body)) {
    return { kind: 'negeren', reden: 'geen object' };
  }
  if (typeof body.challenge === 'string') {
    return { kind: 'challenge', challenge: body.challenge };
  }
  const event = body.event;
  if (!isRecord(event) || typeof event.type !== 'string') {
    return { kind: 'negeren', reden: 'geen event' };
  }
  if (alsId(event.boardId) !== labelsBoardId) {
    return { kind: 'negeren', reden: `ander bord: ${alsId(event.boardId) ?? 'onbekend'}` };
  }
  if (!EVENTS.has(event.type)) {
    return { kind: 'negeren', reden: `event ${event.type}` };
  }
  return { kind: 'sync' };
}
