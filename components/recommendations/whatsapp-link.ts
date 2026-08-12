/**
 * The per-trainer "stuur WhatsApp" deep link.
 *
 * Legacy Airtable had one of these on every recommendation row and the planners use it
 * daily — Peter asked after it by name. The build spec traded it for a single copyable
 * message per training (`03-aanbevelingsengine.md:238`), which is what shipped first; this
 * puts the link back on top of that same message, so the text stays one editable thing and
 * only the recipient differs per row.
 *
 * Everything here is pure so the two fiddly parts — a Dutch phone number and the greeting
 * — are testable without a browser.
 */

/**
 * The generated message's first line, duplicated from `lib/recommend/whatsapp.ts`.
 *
 * Deliberately not imported: that module lives behind the engine's barrel and pulls the
 * Upstash client and `node:crypto` into anything that touches it, none of which belongs in
 * a planner's browser. Same reasoning as the wire shapes in `types.ts`. If it ever drifts,
 * the fallback below still produces a correct greeting — just on its own line.
 */
const HEADER = 'Ben jij beschikbaar?';

/**
 * Whether the message on hand may be sent from a table row.
 *
 * The panel can warn and offer Herladen; a row link has nowhere to put a warning and no
 * way to recover, so anything but `ok` disables it.
 *
 * - `stale` — a saved edit written against older training details.
 * - `error` — the last refresh failed, so this is the PREVIOUS message. Without this the
 *   links stay live on a freshly recalculated list, sending the old date to everyone.
 * - `pending` — a refresh has not been read yet, either still in flight or deferred behind
 *   an unsaved draft. The list on screen is already the new one; this text is not.
 * - `unreadable` — a saved edit exists and could not be read, so this is the generated
 *   fallback. Sending it would quietly discard whatever a colleague wrote.
 * - `conflict` — a save came back 409: a colleague wrote while this draft was open, and the
 *   panel is asking the planner to choose. The text in hand is the losing version, so
 *   sending it from a row would settle that question by accident.
 *
 * `warnings` are deliberately NOT here. The panel treats them as warnings rather than
 * blocks — a message missing its location is still worth sending — so the link keeps that
 * contract and carries them in its tooltip instead of refusing.
 */
export type MessageState = 'ok' | 'stale' | 'error' | 'pending' | 'unreadable' | 'conflict';

/** Dutch mobile numbers are 31 + 9 digits; allow room for anything already international. */
const MIN_DIGITS = 9;
const MAX_DIGITS = 15;
const NL_COUNTRY_CODE = '31';

/**
 * A Dutch number as `wa.me` wants it: digits only, country code, no leading `+`.
 *
 * ITG's board holds these however whoever typed them felt at the time — `0611771540`,
 * `+31 6 11 77 15 40`, `0031611771540` all appear. Returns null rather than guessing when
 * the result could not be a phone number, so the button disables instead of opening a chat
 * with a stranger.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits === '') {
    return null;
  }

  // `00` is the international prefix; `0` is the national trunk prefix. Both are dropped
  // in favour of an explicit country code, and only then is the length meaningful.
  const international = digits.startsWith('00')
    ? digits.slice(2)
    : digits.startsWith('0')
      ? `${NL_COUNTRY_CODE}${digits.slice(1)}`
      : digits;

  if (international.length < MIN_DIGITS || international.length > MAX_DIGITS) {
    return null;
  }
  return international;
}

/**
 * The message addressed to one trainer.
 *
 * Legacy folded the name into the opening line — "Hey Carlijn, ben jij beschikbaar?" —
 * rather than adding a line, so that shape is reproduced when the message still opens with
 * the generated header. A planner who rewrote the opening gets the greeting on its own
 * line instead: guessing at where a name belongs in prose someone else wrote is how you
 * end up mangling it.
 */
export function personalise(message: string, fullName: string | null): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  if (first === '') {
    return message;
  }
  if (message.startsWith(HEADER)) {
    const rest = message.slice(HEADER.length);
    return `Hey ${first}, ben jij beschikbaar?${rest}`;
  }
  return `Hey ${first},\n\n${message}`;
}

/**
 * The full `wa.me` URL, or null when there is nothing safe to link to.
 *
 * `wa.me` rather than `web.whatsapp.com`: it redirects to the desktop app, the web client
 * or the phone depending on where it is opened, which is what makes it work for a planner
 * on either machine.
 */
export function whatsappHref(
  phone: string | null | undefined,
  message: string,
  fullName: string | null
): string | null {
  const number = normalisePhone(phone);
  if (number === null || message.trim() === '') {
    return null;
  }
  return `https://wa.me/${number}?text=${encodeURIComponent(personalise(message, fullName))}`;
}
