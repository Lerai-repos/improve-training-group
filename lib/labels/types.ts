/**
 * De labelconfiguratie: één rij per merk waaronder ITG traint.
 *
 * Negen labels, één bron, meerdere afnemers — het rapport pakt kleur/naam/rapportterm en de
 * afbeeldingen, de inventarisatielink pakt de website, de mails pakken de
 * evaluatieformulier-URL. Vandaar één bord in plaats van drie losse lijstjes.
 */

/**
 * Een labelafkorting: de naam van een rij op het Labels-bord, en dezelfde tekst in `status23`
 * op de agenda en in `Label` op de Opportunity.
 *
 * Een gewone string sinds 13-Oct-2026: ITG voegt zelf labels toe door een rij op het bord te
 * zetten (Peter, voor de dertien testsites onder `ITG`). De negen waarmee het bord begon staan
 * nog in `LABEL_CODES`, omdat zij een eigen briefingsjabloon hebben.
 */
export type LabelCode = string;

/**
 * Wat er per label op het bord staat.
 *
 * Een leeg tekstveld is een échte toestand, geen fout: FT heeft vandaag geen website en geen
 * evaluatieformulier. Wie een veld nódig heeft controleert dat zelf — het rapport op kleur en
 * naam, de inventarisatielink op website. Dit type
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
  /**
   * De labelsite. Daarop staat `/inventarisatie` met het generieke formulier; de link op de
   * Opportunity wordt hiervan gemaakt (`lib/inventarisatie`).
   *
   * Er stond ook een kolom Inventarisatieformulier met een Google Form per label. Sinds
   * 13-Oct-2026 is er één generiek formulier op de labelsites, dus die is weg.
   */
  readonly website: string;
}
