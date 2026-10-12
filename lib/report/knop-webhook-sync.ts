import { EVAL_STATUS_COLUMN } from './knop';

/** Eén webhook zoals `webhooks(board_id:)` hem teruggeeft. */
export interface WebhookRij {
  readonly id: string;
  readonly event: string;
  /** Een Ruby-hash als tekst, bijvoorbeeld `{"columnId" => {... "columnId" => "x" ...}}`. */
  readonly config: string | null;
}

export const EVAL_STATUS_EVENT = 'change_status_column_value';

/** Zit deze webhook op `Eval Status`? Monday geeft geen URL terug, dus alleen zo te herkennen. */
export function isEvalStatusWebhook(rij: WebhookRij): boolean {
  return rij.event === EVAL_STATUS_EVENT && (rij.config ?? '').includes(`"${EVAL_STATUS_COLUMN}"`);
}

/**
 * Welke webhooks weg moeten nadat de onze is aangemaakt: elke andere op `Eval Status`.
 *
 * Monday geeft de URL van een webhook niet terug, dus "die van n8n" is niet te herkennen.
 * Wel dat er na deze stap precies één webhook op `Eval Status` hoort te staan: de onze. Dat
 * maakt het script ook herhaalbaar — een tweede keer draaien maakt een nieuwe en ruimt de
 * vorige op.
 */
export function teVerwijderen(rijen: readonly WebhookRij[], nieuwId: string): readonly string[] {
  return rijen.filter((r) => r.id !== nieuwId && isEvalStatusWebhook(r)).map((r) => r.id);
}
