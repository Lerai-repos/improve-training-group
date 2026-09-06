import { describeError } from './error-text';
import { MailSendError } from './graph-sender';

import type { MailSender, OutgoingMail } from './types';

/**
 * Eén keer opnieuw proberen bij een storing die overwaait.
 *
 * Gemeten op de eerste echte verzending: negen van de tien mails gingen goed en één viel om
 * met `fetch failed` — een weggevallen socket, geen weigering van Exchange, want de andere
 * bijlage-mails van dezelfde grootte kwamen er wél doorheen. Precies het soort storing dat
 * een tweede poging oplost.
 *
 * ## Alleen bij een storing, nooit bij een weigering
 *
 * Een 403 betekent dat de Exchange-scope dit postvak niet toestaat, en een 400 dat het
 * bericht niet deugt. Die worden bij een tweede poging exact zo geweigerd; opnieuw proberen
 * kost dan alleen tijd uit de looptijdgrens van de route, en die tijd is er voor de mails die
 * nog moeten.
 *
 * ## Een herhaling kan dubbel aankomen, en dat is de bedoelde ruil
 *
 * Valt de verbinding weg NÁ het verzenden maar vóór het antwoord, dan is er hier geen verschil
 * te zien met een verzending die nooit vertrok — Graph kent geen idempotency-sleutel voor
 * `sendMail`. Een tweede poging levert dan een dubbele mail op in ITG's eigen postbus.
 * Zichtbaar en te herstellen, tegenover een aftersalesmail die een accountmanager nooit krijgt
 * en die niemand mist. Dezelfde afweging als bij het teruggeven van de claim.
 */

/** Twee pogingen extra; daarna is het geen storing meer maar een probleem. */
export const MAIL_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 3_000] as const;

/** Netwerkfouten die undici en Node zelf teruggeven als er onderweg iets wegvalt. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;

/**
 * De HTTP-status van een fout, als hij er een draagt.
 *
 * **Er zijn er TWEE die dat doen, en dat was bijna een stille misser.** `MailSendError` komt
 * alleen van het uploaden van een bijlagebrok; élke andere stap — `sendMail`, het concept
 * aanmaken, de uploadsessie openen, het versturen — loopt door de Graph-client en werpt diens
 * `GraphError`. Keek dit alleen naar `MailSendError`, dan gold een 429 of 503 op precies het
 * meest gebruikte pad als een blijvende weigering en werd er nooit opnieuw geprobeerd.
 *
 * Op de VORM en niet op de klasse: `lib/mail` kent de Graph-client alleen via een smalle poort
 * (`GraphJson`), en die lijn doortrekken naar de fouten scheelt een import naar een module
 * waar dit verder niets van hoeft te weten. Een `Error` met een numerieke `status` is in deze
 * codebase een HTTP-fout.
 */
function httpStatus(error: unknown): number | null {
  if (error instanceof MailSendError) {
    return error.status;
  }
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return null;
}

export function isTransient(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== null) {
    return status === TOO_MANY_REQUESTS || status >= SERVER_ERROR;
  }
  /**
   * Een afbreking is GEEN storing die overwaait.
   *
   * Die komt van onze eigen looptijdgrens, en nog eens proberen loopt gegarandeerd tegen
   * dezelfde grens aan — met minder tijd voor de mails die nog moeten.
   */
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  const beschrijving = describeError(error);
  if (beschrijving.includes('fetch failed')) {
    return true;
  }
  return [...TRANSIENT_CODES].some((code) => beschrijving.includes(code));
}

export interface RetryOptions {
  readonly attempts?: number;
  /** Injecteerbaar, zodat een test niet echt hoeft te wachten. */
  sleep?: (ms: number) => Promise<void>;
  /** Elke mislukte poging, voor het logboek. */
  onRetry?: (poging: number, fout: string) => void;
}

const wacht = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function sendWithRetry(
  sender: MailSender,
  mail: OutgoingMail,
  options: RetryOptions = {}
): Promise<void> {
  const attempts = options.attempts ?? MAIL_ATTEMPTS;
  const sleep = options.sleep ?? wacht;

  for (let poging = 1; ; poging += 1) {
    try {
      await sender.send(mail);
      return;
    } catch (error) {
      if (poging >= attempts || !isTransient(error)) {
        throw error;
      }
      options.onRetry?.(poging, describeError(error));
      await sleep(BACKOFF_MS[Math.min(poging - 1, BACKOFF_MS.length - 1)]);
    }
  }
}
