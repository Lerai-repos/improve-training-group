/**
 * De teksten van de briefing, beheerd door ITG op het bord Briefingteksten.
 *
 * Tim, 30-Sep-2026: ITG wil élke tekst in de briefing zelf kunnen aanpassen. Wat zij beheren
 * is de WOORDEN; de opmaak (koppen, witregels, volgorde, wanneer een sectie verschijnt) blijft
 * van de code en het sjabloon. Zo kan een bewerking in Monday de tekst veranderen maar nooit
 * de opbouw van het document.
 */

/** Eén regel tekst zoals het sjabloon hem opmaakt. Zelfde vorm als `BlockLine` in de briefing. */
export interface TekstRegel {
  readonly tekst: string;
  readonly bullet: boolean;
  /** `0` of `1`: het inspringniveau van een opsommingsregel. */
  readonly niveau: 0 | 1;
}

/**
 * Een waarde die de briefing zelf invult.
 *
 * `merk` en `term` komen van het Labels-bord en mogen overal; de rest hoort bij één soort
 * sectie en staat per sectie in de catalogus.
 */
export type Plaatshouder = 'merk' | 'term' | 'trainers' | 'acteurs' | 'duur' | 'aantal';

/**
 * De vaste sleutel van een sectie.
 *
 * Hierop vindt de code een item terug, en níét op de itemnaam of de groep: ITG mag items
 * hernoemen en verslepen zonder dat er iets breekt.
 */
export type TekstSleutel =
  | 'algemeen.inleiding'
  | 'algemeen.vlag'
  | 'algemeen.vervolg'
  | 'algemeen.materialen'
  | 'algemeen.inhoud'
  | 'algemeen.afsluiting'
  | 'algemeen.monday-challenges'
  | 'rol.leadtrainer'
  | 'rol.co-trainer'
  | 'rol.met-acteur'
  | 'rol.als-acteur'
  | 'concept.inleiding'
  | 'groep.eigen'
  | 'groep.samen'
  | 'vaste-klant'
  | 'cyclus.inleiding'
  | 'cyclus.huiswerk'
  | 'cyclus.voorbereiding'
  | 'cyclus.afsluiting'
  | 'opdracht.huiswerk'
  | 'opdracht.voorbereidend'
  | 'inventarisatie.inleiding'
  | 'inventarisatie.leeg';

/** De groepen op het bord, in documentvolgorde. Alleen voor de leesbaarheid; de code kijkt er niet naar. */
export type TekstGroep =
  | 'Algemeen'
  | 'Rollen'
  | 'Concept inhoud'
  | 'Groepsindeling'
  | 'Vaste klant'
  | 'Cyclus'
  | 'Opdrachten'
  | 'Inventarisatie';

export interface SectieDefinitie {
  readonly sleutel: TekstSleutel;
  readonly groep: TekstGroep;
  /** De itemnaam op het bord. */
  readonly naam: string;
  /** Of deze sectie een kop kán hebben. Zo niet, dan is een ingevulde Kop een fout. */
  readonly heeftKop: boolean;
  /** De beginwaarde van Kop, zoals de briefing hem op 30-Sep-2026 had. */
  readonly kop: string;
  /** De beginwaarde van Tekst, in de regelnotatie van `regels.ts`. */
  readonly tekst: string;
  /** Welke plaatshouders er naast `{merk}` en `{term}` mogen staan. */
  readonly plaatshouders: readonly Plaatshouder[];
  /** Wanneer de sectie in de briefing staat, voor de kolom Uitleg. */
  readonly wanneer: string;
}

/**
 * Wat een sectie in de briefing oplevert.
 *
 * `leeg` is een geldige keuze van ITG en laat de sectie verdwijnen. `fout` is dat níét: dan
 * komt er een zichtbare regel in het document, zodat `{mrek}` nooit bij een trainer belandt.
 */
export type SectieStaat =
  | { readonly kind: 'tekst'; readonly kop: string; readonly regels: readonly TekstRegel[] }
  | { readonly kind: 'leeg' }
  | { readonly kind: 'fout'; readonly melding: string };

/** Alle teksten voor één briefing: per sectie de staat, plus het merk van het label. */
export interface BriefingTeksten {
  readonly secties: Readonly<Record<TekstSleutel, SectieStaat>>;
  /** `Incompany Trainer` — de volledige naam van het label. */
  readonly merk: string;
  /** `training` — de term van het label, in kleine letters voor midden in een zin. */
  readonly term: string;
}

/** De labels van de kolom Status op het bord. */
export type TekstStatus = 'OK' | 'Fout' | 'Leeg' | 'Niet gekoppeld';
