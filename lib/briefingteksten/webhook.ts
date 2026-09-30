import { TEKST_COLUMNS } from './columns';

import type { StatusWijziging } from './status';

/**
 * De webhook van het bord: bij elke bewerking de kolom Status bijwerken.
 *
 * Zo ziet iemand die `{mrek}` typt binnen een paar seconden een rode Fout naast zijn tekst,
 * in plaats van het te horen van een trainer.
 *
 * **De lusbeveiliging zit hier.** Ons eigen wegschrijven van Status en Melding is óók een
 * kolomwijziging en komt dus óók als webhook binnen. Alleen Kop, Tekst en Sleutel zetten een
 * nieuwe keuring in gang; de rest wordt genegeerd.
 */

export type TekstWebhook =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'keuren' }
  | { readonly kind: 'negeren'; readonly reden: string };

const KOLOMWIJZIGING = new Set([
  'update_column_value',
  'change_column_value',
  'change_specific_column_value',
]);
const NIEUW_ITEM = new Set(['create_pulse', 'create_item']);
const BEWERKBAAR: ReadonlySet<string> = new Set([
  TEKST_COLUMNS.kop,
  TEKST_COLUMNS.tekst,
  TEKST_COLUMNS.sleutel,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const alsId = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export function parseTekstWebhook(body: unknown, boardId: string): TekstWebhook {
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
  if (alsId(event.boardId) !== boardId) {
    return { kind: 'negeren', reden: 'ander bord' };
  }
  if (NIEUW_ITEM.has(event.type)) {
    return { kind: 'keuren' };
  }
  if (KOLOMWIJZIGING.has(event.type)) {
    return typeof event.columnId === 'string' && BEWERKBAAR.has(event.columnId)
      ? { kind: 'keuren' }
      : { kind: 'negeren', reden: 'kolom die ITG niet bewerkt' };
  }
  return { kind: 'negeren', reden: `event ${event.type}` };
}

export interface WebhookAntwoord {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Een mislukte keuring geeft 500, zodat Monday het event opnieuw aflevert (een half uur
 * lang). Een verkeerde Status is geen ramp — de briefing keurt zelf opnieuw bij het lezen —
 * maar hij hoort niet te blijven staan.
 */
export async function verwerkTekstWebhook(
  parse: TekstWebhook,
  keuren: () => Promise<readonly StatusWijziging[]>
): Promise<WebhookAntwoord> {
  if (parse.kind === 'challenge') {
    return { status: 200, body: { challenge: parse.challenge } };
  }
  if (parse.kind === 'negeren') {
    return { status: 200, body: { genegeerd: parse.reden } };
  }
  try {
    const wijzigingen = await keuren();
    return { status: 200, body: { bijgewerkt: wijzigingen.length } };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
