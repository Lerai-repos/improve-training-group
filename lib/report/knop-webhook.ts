import type { KvStore } from '@lib/recommend/kv';
import type { EvalKnopWebhook } from './knop';

/**
 * Hoe lang een afgeleverd event onthouden wordt. Monday herhaalt een webhook tot een half uur
 * lang; een uur zit daar ruim boven.
 */
export const TRIGGER_TTL_MS = 60 * 60 * 1000;

export interface WebhookAntwoord {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface EvalKnopWebhookDeps {
  /** Pas opgehaald bij een echte knopdruk: een genegeerd event raakt KV niet aan. */
  kv: () => KvStore;
  /** Start de verwerking ná het antwoord aan Monday (`after()` in de route). */
  start: (itemId: string, boardId: string) => void;
}

/**
 * Wat de route met een geparste webhook doet.
 *
 * **Meteen antwoorden, daarna pas werken.** Een rapport maken start Chromium en leest drie
 * sheets; dat duurt langer dan Monday op een antwoord wacht, en dan levert hij het event
 * opnieuw af. Bewust géén wachtrij met herhalingen: de knop stuurt altijd, dus elke herhaling
 * zou de mails opnieuw versturen. Mislukt de verwerking, dan zegt `Zie Systeem-bord` dat, en
 * drukt iemand opnieuw.
 *
 * **Eén keer per event.** Monday levert een webhook soms dubbel af; op `triggerUuid`
 * onthouden voorkomt dat de mails dan twee keer gaan. Een nieuwe knopdruk heeft een nieuwe
 * `triggerUuid` en gaat dus gewoon door.
 */
export async function verwerkEvalKnopWebhook(
  parse: EvalKnopWebhook,
  deps: EvalKnopWebhookDeps
): Promise<WebhookAntwoord> {
  if (parse.kind === 'challenge') {
    return { status: 200, body: { challenge: parse.challenge } };
  }
  if (parse.kind === 'negeren') {
    return { status: 200, body: { genegeerd: parse.reden } };
  }
  if (parse.triggerUuid !== null) {
    const eerste = await deps.kv().setIfAbsent(`evalknop:trigger:${parse.triggerUuid}`, '1', {
      ttlMs: TRIGGER_TTL_MS,
    });
    if (!eerste) {
      return { status: 200, body: { genegeerd: 'al verwerkt' } };
    }
  }
  deps.start(parse.itemId, parse.boardId);
  return { status: 200, body: { gestart: parse.itemId } };
}
