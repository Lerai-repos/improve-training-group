import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';

import type { LinkUitkomst } from './run';

/**
 * De webhooks op het Opportunitybord: een nieuwe Opportunity, of een ander label.
 *
 * Alleen die twee, zodat de link er staat zodra de Opportunity er is (Tim, 13-Oct-2026). Ons
 * eigen wegschrijven van de link is een wijziging in een andere kolom en zet dus niets in gang.
 */

export type InventarisatieWebhook =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'sync'; readonly itemId: string }
  | { readonly kind: 'negeren'; readonly reden: string };

const NIEUW_ITEM = new Set(['create_pulse', 'create_item']);
const KOLOMWIJZIGING = new Set([
  'update_column_value',
  'change_column_value',
  'change_specific_column_value',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const alsId = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export function parseInventarisatieWebhook(body: unknown): InventarisatieWebhook {
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
  if (alsId(event.boardId) !== OPPORTUNITY_BOARD) {
    return { kind: 'negeren', reden: 'ander bord' };
  }
  const itemId = alsId(event.pulseId);
  if (itemId === null) {
    return { kind: 'negeren', reden: 'geen item in het event' };
  }
  if (NIEUW_ITEM.has(event.type)) {
    return { kind: 'sync', itemId };
  }
  if (KOLOMWIJZIGING.has(event.type)) {
    return event.columnId === OPPORTUNITY_COLUMNS.label
      ? { kind: 'sync', itemId }
      : { kind: 'negeren', reden: 'andere kolom' };
  }
  return { kind: 'negeren', reden: `event ${event.type}` };
}

export interface WebhookAntwoord {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Een mislukte sync geeft 500, zodat Monday het event opnieuw aflevert; lukt dat ook niet,
 * dan zet de nachtelijke ronde het recht.
 */
export async function verwerkInventarisatieWebhook(
  parse: InventarisatieWebhook,
  sync: (itemId: string) => Promise<LinkUitkomst>
): Promise<WebhookAntwoord> {
  if (parse.kind === 'challenge') {
    return { status: 200, body: { challenge: parse.challenge } };
  }
  if (parse.kind === 'negeren') {
    return { status: 200, body: { genegeerd: parse.reden } };
  }
  try {
    return { status: 200, body: { itemId: parse.itemId, link: await sync(parse.itemId) } };
  } catch (error) {
    return {
      status: 500,
      body: { itemId: parse.itemId, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
