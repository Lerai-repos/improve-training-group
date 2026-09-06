import { aftersalesMet, aftersalesZonder, trainerMet, trainerZonder } from './text';

import type { MailFacts } from './facts';
import type { MailRecipients } from './recipients';
import type { MailVariant } from './sent-store';
import type { MailAttachment, OutgoingMail } from './types';

/**
 * Van één uitkomst naar de twee mails die eruit horen te gaan.
 *
 * Per training gaan er altijd **twee** weg, nooit één: een aftersalesmail naar de
 * accountmanagers en een trainermail naar backoffice. Ze gaan naar verschillende postbussen
 * en hebben verschillende teksten, maar ze horen bij dezelfde sessie, en de een zonder de
 * ander laat een van beide kanten met een halve waarheid zitten.
 */

/** Naar welke postbus deze mail gaat. Alleen voor het logboek en de grendel. */
export type MailDoel = 'klant' | 'trainer';

export interface ComposedMail {
  readonly doel: MailDoel;
  readonly mail: OutgoingMail;
}

/**
 * Tekens die in een bestandsnaam niet horen, vervangen door een spatie.
 *
 * De klanttitel komt van het agendabord en is met de hand getypt; er staan schuine strepen
 * en dubbele punten in ("Bouw / Techniek: dag 2"). Die gaan mee in de bestandsnaam van een
 * bijlage, en een ontvanger met Windows kan zo'n bestand niet opslaan.
 */
function veiligeBestandsnaam(titel: string): string {
  const schoon = titel
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return schoon === '' ? 'training' : schoon;
}

export function rapportBestandsnaam(facts: MailFacts): string {
  const datum = facts.datum === '' ? '' : ` (${facts.datum})`;
  return `Evaluatierapport ${veiligeBestandsnaam(facts.klanttitel)}${datum}.pdf`;
}

export function pdfBijlage(facts: MailFacts, pdf: Uint8Array): MailAttachment {
  return {
    filename: rapportBestandsnaam(facts),
    contentType: 'application/pdf',
    bytes: pdf,
  };
}

/** De regel die bovenaan komt als er huisstijl miste, of leeg als alles goed ging. */
function waarschuwingsregel(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return '';
  }
  return (
    `LET OP: het rapport mist huisstijl (${warnings.join('; ')}). ` +
    'Controleer de bijlage voordat je hem doorstuurt.'
  );
}

/** De waarschuwing als eerste regel van de kop, vóór alles wat ITG verder moet doen. */
function metWaarschuwing(
  tekst: { readonly subject: string; readonly body: string },
  waarschuwing: string
): { readonly subject: string; readonly body: string } {
  if (waarschuwing === '') {
    return tekst;
  }
  return { subject: tekst.subject, body: `${waarschuwing}\n\n${tekst.body}` };
}

export interface ComposeInput {
  readonly variant: MailVariant;
  readonly facts: MailFacts;
  readonly recipients: MailRecipients;
  /**
   * Het rapport. Hoort bij `met` en bij niets anders.
   *
   * Er is geen variant met een bijlage die geen rapport is, en geen `met` zonder rapport: dat
   * zou een mail opleveren die zegt "ik heb de uitslag bijgevoegd" met niets erbij.
   */
  readonly rapport?: Uint8Array;
  /**
   * Afbeeldingen die niet opgehaald konden worden bij het maken van het rapport.
   *
   * Komen bovenaan in de kop terecht, bij de rest van wat ITG moet weten. Het rapport gaat
   * gewoon mee — het is zonder logo nog steeds bruikbaar — maar wie het doorstuurt hoort te
   * weten dat er huisstijl mist, want dat is niet aan het bestand te zien zonder het te
   * openen, en de mail eromheen ziet er verzorgd uit.
   */
  readonly warnings?: readonly string[];
}

export function composeMails(input: ComposeInput): readonly ComposedMail[] {
  const { facts, recipients } = input;
  const waarschuwing = waarschuwingsregel(input.warnings ?? []);

  if (input.variant === 'zonder') {
    const klant = aftersalesZonder(facts);
    const trainer = trainerZonder(facts);
    return [
      { doel: 'klant', mail: { to: [recipients.klant], ...metWaarschuwing(klant, waarschuwing) } },
      {
        doel: 'trainer',
        mail: { to: [recipients.trainer], ...metWaarschuwing(trainer, waarschuwing) },
      },
    ];
  }

  if (input.rapport === undefined) {
    throw new Error(
      'De MET-variant belooft in beide teksten dat de uitslag is bijgevoegd; zonder rapport ' +
        'zou die zin onwaar zijn.'
    );
  }

  const bijlage = pdfBijlage(facts, input.rapport);
  const klant = aftersalesMet(facts);
  const trainer = trainerMet(facts);
  return [
    {
      doel: 'klant',
      mail: {
        to: [recipients.klant],
        ...metWaarschuwing(klant, waarschuwing),
        attachment: bijlage,
      },
    },
    {
      doel: 'trainer',
      mail: {
        to: [recipients.trainer],
        ...metWaarschuwing(trainer, waarschuwing),
        attachment: bijlage,
      },
    },
  ];
}
