/**
 * Wie er verstuurt en waar het heen gaat.
 *
 * De twee bestemmingen staan letterlijk in `04-evaluatierapportage.md`, in de ondertitel van
 * elke mailvariant: de klantmails naar `aanvragen@`, de trainermails naar `backoffice@`. Het
 * zijn allebei gedeelde postbussen waar alle accountmanagers bij kunnen.
 *
 * ## Waarom dit code is en geen rij op het Instellingen-bord
 *
 * Het Instellingen-bord draagt bedragen en drempels — dingen die ITG zelf verandert omdat de
 * prijzen veranderen. Een verkeerd getikt bedrag levert een verkeerde offerte op; een
 * verkeerd getikt e-mailadres stuurt klantgegevens naar een vreemde. Dat verschil is groot
 * genoeg om deze drie in de repo te houden, waar een wijziging een review passeert.
 *
 * ## De override is er voor de eerste echte verzending
 *
 * `ITG_MAIL_KLANT` en `ITG_MAIL_TRAINER` bestaan zodat de eerste live test naar een eigen
 * adres kan in plaats van naar de postbus waar ITG dagelijks in werkt. Zonder die uitweg is
 * de enige manier om te controleren óf het werkt, het meteen bij de klant te laten landen.
 */

/**
 * Het postvak waaruit verzonden wordt.
 *
 * Exchange laat dit alleen toe binnen de scope `Lerai verzendpostvak` — de app mag als dit
 * ene postvak verzenden en als geen enkel ander. Verander dit adres en de verzending valt
 * stil met een 403 in plaats van als iemand anders te gaan verzenden, en dat is de bedoeling.
 */
export const MAIL_SENDER = 'automatisering@improvetraininggroup.nl';

const KLANT_MAILBOX = 'aanvragen@improvetraininggroup.nl';
const TRAINER_MAILBOX = 'backoffice@improvetraininggroup.nl';

export interface MailRecipients {
  /** De aftersalesmails, bestemd voor de accountmanager. */
  readonly klant: string;
  /** De trainermails, bestemd voor backoffice. */
  readonly trainer: string;
  /** Waar verzonden wordt uit; zit in geen enkele override. */
  readonly sender: string;
}

/**
 * De bestemmingen, met een omleiding voor een test.
 *
 * De afzender is met opzet **niet** te overschrijven: die is aan de Exchange-scope
 * vastgeklonken, en een env-waarde die daarvan afwijkt levert alleen een mislukte verzending
 * op die eruitziet als een codefout.
 */
export function mailRecipients(
  /**
   * Alleen wat er gelezen wordt, niet `NodeJS.ProcessEnv`. Dat type eist `NODE_ENV`, en dan
   * kan een test niet zeggen "een omgeving zonder omleiding" zonder er onzin bij te verzinnen.
   */
  env: Readonly<Record<string, string | undefined>> = process.env
): MailRecipients {
  const klant = (env.ITG_MAIL_KLANT ?? '').trim();
  const trainer = (env.ITG_MAIL_TRAINER ?? '').trim();
  return {
    klant: klant === '' ? KLANT_MAILBOX : klant,
    trainer: trainer === '' ? TRAINER_MAILBOX : trainer,
    sender: MAIL_SENDER,
  };
}

/** Of er vandaag omgeleid wordt. De dagjob logt dit, zodat een testrun niet als echt leest. */
export function isRedirected(recipients: MailRecipients): boolean {
  return recipients.klant !== KLANT_MAILBOX || recipients.trainer !== TRAINER_MAILBOX;
}
