import { firstNames, joinDutch, trainerWord } from '@lib/report/text';

/**
 * De gegevens die in de mailteksten worden ingevuld — de gele arceringen uit het
 * V2-document van juli, uitgerekend en al in de vorm waarin ze in de zin komen.
 *
 * Bewust gescheiden van de teksten zelf: hier zit het rekenwerk en de opmaak van namen en
 * datums, daar staat de copy. Zo is te testen dát een percentage klopt zonder een lap tekst
 * te vergelijken, en te testen dat de tekst loopt zonder een training te hoeven verzinnen.
 */

/** Wat ITG zelf nog invult, altijd op deze manier gemarkeerd zodat het opvalt bij het plakken. */
export const INVULLEN = (instructie: string): string => `[${instructie}]`;

export interface MailFacts {
  /** "3 september 2026". */
  readonly datum: string;
  /** De klanttitel van de agenda: "Building Boksing + Conflicthantering". */
  readonly klanttitel: string;
  /** De thema's van de training, samengevoegd. Leeg als er geen thema gekoppeld is. */
  readonly thema: string;
  /** "Incompany Trainer" — het merk waaronder getraind is. */
  readonly labelNaam: string;
  /** "de training" / "de teambuilding"; loopt middenin een zin. */
  readonly rapportterm: string;
  /** De klanttevredenheids-URL van het label, of leeg als het label er geen heeft. */
  readonly evaluatieformulier: string;
  /** Voornamen van de contactpersonen, samengevoegd. Leeg als de kolom leeg is. */
  readonly contactNamen: string;
  /** Voornamen van de trainers, samengevoegd. */
  readonly trainerNamen: string;
  /** "trainer" of "trainers". */
  readonly trainerWoord: string;
  /** De e-mailadressen van de trainers, voor de instructieregel in de trainermail. */
  readonly trainerEmails: readonly string[];
  /** De accountmanager van deze training; leeg als de people-kolom leeg is. */
  readonly accountmanager: string;
  readonly ieCode: string;
  readonly aantalRespondenten: number;
  /** "7.8", of null als geen enkele respondent een cijfer gaf. */
  readonly gemiddelde: string | null;
  /**
   * Het percentage dat een verdiepende sessie waardevol vindt, of null.
   *
   * Berekend over wie de vraag beantwoordde, niet over alle respondenten — precies zoals de
   * taartgrafiek in het rapport. Zou de mail over álle respondenten rekenen, dan noemt de
   * brief een lager percentage dan het document dat eraan vastzit, en dat verschil valt op
   * bij de eerste klant die beide naast elkaar legt.
   */
  readonly vervolgPercentage: number | null;
}

/**
 * `2026-09-03` → `3 september 2026`.
 *
 * Uit de losse delen opgebouwd en in UTC geformatteerd: de waarde is een kalenderdatum
 * zonder tijd, en hem door een tijdzone halen kan hem een dag verschuiven — precies de fout
 * die in een brief aan een klant nooit opvalt en altijd verkeerd is.
 */
export function dutchDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (match === null) {
    return iso.trim();
  }
  const [, year, month, day] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

export interface FactsInput {
  readonly datum: string | null;
  readonly klanttitel: string;
  readonly themaNamen: readonly string[];
  readonly labelNaam: string;
  readonly rapportterm: string;
  readonly evaluatieformulier: string;
  readonly contactPersoon: string;
  readonly trainerNamen: readonly string[];
  readonly trainerEmails: readonly string[];
  readonly accountmanager: string;
  readonly ieCode: string;
  readonly aantalRespondenten: number;
  readonly gemiddelde: string | null;
  readonly vervolgPercentage: number | null;
}

export function buildMailFacts(input: FactsInput): MailFacts {
  const voornamen = input.trainerNamen.map((n) => n.trim().split(/\s+/)[0] ?? '');
  return {
    datum: input.datum === null ? '' : dutchDate(input.datum),
    klanttitel: input.klanttitel,
    thema: joinDutch(input.themaNamen),
    labelNaam: input.labelNaam,
    rapportterm: input.rapportterm,
    evaluatieformulier: input.evaluatieformulier.trim(),
    contactNamen: joinDutch(firstNames(input.contactPersoon)),
    trainerNamen: joinDutch(voornamen),
    trainerWoord: trainerWord(voornamen.filter((n) => n !== '').length),
    trainerEmails: input.trainerEmails.filter((e) => e.trim() !== ''),
    accountmanager: input.accountmanager.trim(),
    ieCode: input.ieCode,
    aantalRespondenten: input.aantalRespondenten,
    gemiddelde: input.gemiddelde,
    vervolgPercentage: input.vervolgPercentage,
  };
}
