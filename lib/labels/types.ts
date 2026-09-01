/**
 * De labelconfiguratie: één rij per merk waaronder ITG traint.
 *
 * Negen labels, één bron, meerdere afnemers — het rapport pakt kleur/naam/rapportterm en de
 * afbeeldingen, de briefing pakt website en inventarisatieformulier, de mails pakken de
 * evaluatieformulier-URL. Vandaar één bord in plaats van drie losse lijstjes.
 */

/** De negen labelafkortingen. Komt overeen met `status23` op het agendabord. */
export type LabelCode = 'IT' | 'JE' | 'TT' | 'FV' | 'SST' | 'WJ' | 'CC' | 'CP' | 'FT';

/**
 * Wat er per label op het bord staat.
 *
 * Een leeg tekstveld is een échte toestand, geen fout: FT heeft vandaag geen website en geen
 * evaluatieformulier, en CC/CP hebben geen inventarisatieformulier. Wie een veld nódig heeft
 * controleert dat zelf — het rapport op kleur en naam, de briefing op website. Dit type
 * dwingt dat niet af, want dan zou één ontbrekend briefingveld het rapport blokkeren.
 */
export interface LabelConfig {
  readonly code: LabelCode;
  /** "Incompany Trainer". Gaat als merknaam in de aanhef van het rapport. */
  readonly volledigeNaam: string;
  /** Hex, bijvoorbeeld `#0A2B58`. De grafiekkleuren worden hiervan afgeleid. */
  readonly kleur: string;
  /** "Training" / "Workshop" / "Teambuilding" / "Cursus". */
  readonly term: string;
  /** "de training" / "de workshop". Loopt middenin een zin, dus met lidwoord en klein. */
  readonly rapportterm: string;
  /** Klanttevredenheidsformulier op de eigen site. Alleen voor de mails, niet voor het rapport. */
  readonly evaluatieformulier: string;
  /** De labelsite, waar de briefing de inspirerende tekst vandaan haalt. */
  readonly website: string;
  /** Google Form dat de klant vóór een training invult; de briefing leest de antwoorden. */
  readonly inventarisatieformulier: string;
}
