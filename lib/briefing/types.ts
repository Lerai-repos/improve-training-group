/**
 * Wat de briefing over één training moet weten, en wat er ontbreekt.
 *
 * Twee soorten fout, en het verschil is het hele punt:
 *
 * - **Schemadrift** (een kolom die niet meer bestaat) is een `throw`. Monday laat een
 *   kolom-id dat het niet kent gewoon wég in plaats van te foutmelden, dus een hernoemde
 *   kolom komt terug als een lege waarde — en die zou hier als "de adviseur is het
 *   vergeten" gelezen worden. Dan staat er een briefing zonder locatie bij de trainer
 *   omdat wíj de kolom kwijt zijn.
 * - **Een leeg veld** is normaal en verwacht. Dat komt in `missing` terecht en stuurt
 *   `Brie` naar "Begonnen, niet klaar" mét de naam van het veld, precies zoals FOUT dat
 *   doet bij de aanbevelingen.
 */

import type { BriefingOpdrachten } from './blocks';

/** Een leeg veld dat de adviseur moet invullen. `label` is wat er in Monday staat. */
export interface MissingField {
  readonly column: string;
  readonly label: string;
}

export interface BriefingTrainer {
  readonly itemId: string;
  readonly naam: string;
  /** Uit de Trainers-kolom `telefoon_mkn1hbyh`; leeg is normaal. */
  readonly telefoon: string;
  /**
   * Staat deze persoon in de groep `Acteurs` op het trainersbord?
   *
   * De trainerrelatie mengt trainers en acteurs. `false` betekent hier "niet in die groep
   * gevonden" en niet "zeker geen acteur": de groep is gemeten incompleet, zie
   * `TRAINER_ACTEURS_GROUP` in `columns.ts`.
   */
  readonly isActeur: boolean;
  /**
   * Stond deze persoon in `itg_cotrainers` in plaats van in de leadkolom?
   *
   * Sinds 21-Aug-2026 is dat een **feit van het bord** en geen gok meer. Daarvoor werd de
   * rol afgeleid uit de koppelvolgorde, en die klopte lang niet altijd: Dirkje over hoe het
   * nu gaat, *"Peter geeft vaak aan in de updates wie de lead trainer is. Maar dit gaat
   * vaak niet goed."*
   *
   * Let op: bij de trainingen van vóór de kolomsplitsing staat iedereen nog in de leadkolom,
   * dus daar is dit voor iedereen `false`. Dat is bewust legacy, zie
   * `itg-briefing-open-vragen`.
   */
  readonly isCoTrainer: boolean;
}

/**
 * De ruwe gegevens van één training, vóór opmaak.
 *
 * Alles is een string omdat de briefing tekst is; het omzetten naar de zinnen die in het
 * document staan gebeurt in de opmaaklaag, niet hier. Zo blijft dit testbaar tegen wat
 * Monday werkelijk teruggeeft.
 */
/** Eén gekoppeld thema van het Themas-bord. */
export interface BriefingThema {
  readonly naam: string;
  /** `itg_conceptinhoud`: de standaardbullets, één per regel. Leeg is normaal. */
  readonly conceptInhoud: string;
  /**
   * De Monday Challenge-productcode voor het label van déze training. Leeg is normaal:
   * 19 van de 100 thema's hebben geen challenge.
   */
  readonly mcCode: string;
}

/** Eén sessie van een trainingscyclus: wat per sessie kan verschillen. */
export interface BriefingSessie {
  readonly itemId: string;
  /** Een cyclus kan over twee jaargangen lopen, dus elke sessie draagt haar eigen bord. */
  readonly boardId: string;
  /** Een gearchiveerde jaargang wordt gelezen, maar er wordt niets meer op geschreven. */
  readonly gearchiveerd: boolean;
  /** `YYYY-MM-DD`, of leeg. */
  readonly datum: string;
  readonly tijden: string;
  readonly locatie: string;
  readonly groepsgrootte: string;
  /** Geen thema ingevuld. Doet wel mee, maar de tab meldt het. */
  readonly zonderThema: boolean;
}

/** Eén regel in de vraag "welke sessies horen bij deze cyclus?". */
export interface CyclusOptie {
  readonly itemId: string;
  readonly datum: string;
  readonly klanttitel: string;
  /** Lead- en co-trainers als namen; waar de adviseur op herkent of het klopt. */
  readonly trainers: string;
  /** Deze training zelf: staat er altijd bij en is niet uit te vinken. */
  readonly huidig: boolean;
  readonly aangevinkt: boolean;
  /** Wat de regel voorstelt; los van wat er is aangevinkt of bevestigd. */
  readonly voorgesteld: boolean;
  /** Waarom de regel deze sessie niet voorstelt, of `null` als hij dat wel doet. */
  readonly reden: string | null;
}

/**
 * De vraag die de tab stelt: welke sessies krijgen samen één briefing?
 *
 * Tim, 18-Sep-2026: de regel stelt voor, een mens bevestigt. Tot die bevestiging houdt elke
 * sessie haar eigen briefing.
 */
export interface CyclusKeuze {
  readonly opties: readonly CyclusOptie[];
  /** Er is nog niet bevestigd, of er is een sessie bij gekomen sinds de bevestiging. */
  readonly openstaand: boolean;
}

export interface BriefingCyclus {
  /** De bevestigde sessies, deze training inbegrepen, oudste eerst. */
  readonly sessies: readonly BriefingSessie[];
  /**
   * Het item waar de antwoorden van deze cyclus onder staan — zoals het record het vastlegt,
   * niet zoals het uit de sessies zou zijn af te leiden.
   */
  readonly anker: string;
}

export interface BriefingTraining {
  /**
   * De Trainingscode MC zoals hij in de gegevenstabel komt.
   *
   * Al samengesteld: meerdere thema's met ` & ` aaneen, en `-ENG` per code bij een
   * Engelstalige training. Leeg betekent "dit thema heeft geen Monday Challenge" en dat is
   * een lege regel in het document, geen melding — ITG vult zelf aan waar er wél een hoort.
   */
  readonly trainingscodeMc: string;
  readonly itemId: string;
  readonly naam: string;
  /** Labelafkorting uit `status23`, bv. `IT`. Bepaalt welk sjabloon en welke huisstijl. */
  readonly label: string;
  readonly brie: string;

  readonly opdrachtgever: string;
  readonly themas: readonly string[];
  /**
   * De concept-inhoud van de gekoppelde thema's, samengevoegd.
   *
   * Meestal één thema. Zijn het er meer, dan komen de bullets achter elkaar te staan in de
   * volgorde waarin ze gekoppeld zijn — ontdubbelen zou hier gokken zijn, en de adviseur
   * ziet ze in de app-tab staan en gooit weg wat dubbel is.
   *
   * Leeg betekent dat geen van de gekoppelde thema's een skelet heeft. Dat is een geldige
   * toestand: 65 van de 102 thema's op het bord hebben er geen.
   */
  readonly themaInhoud: string;
  readonly klanttitel: string;
  readonly duur: string;
  readonly datum: string;
  readonly tijden: string;
  readonly groepsgrootte: string;
  readonly locatie: string;
  readonly voertaal: string;
  readonly klantcontactmoment: string;
  readonly evaluatie: string;
  readonly ieCode: string;

  readonly accountmanager: { readonly naam: string; readonly mobiel: string } | null;
  readonly contactpersoon: { readonly naam: string; readonly telefoon: string } | null;
  readonly trainers: readonly BriefingTrainer[];
  /**
   * `Acteuraantal`, of `null` als de kolom leeg is.
   *
   * Null en 0 zijn níét hetzelfde: 264 van de 815 trainingen laten dit leeg, dus "geen
   * acteur" en "niet ingevuld" zijn hier niet uit elkaar te houden. Dit vult de
   * checklistvraag vóór; de adviseur bevestigt.
   */
  readonly acteuraantal: number | null;
  /** Item-id van de gekoppelde Opportunity, voor de updates en de contactpersoon. */
  readonly opportunityItemId: string | null;
  /**
   * De achtergrondinformatie ("de aanleidingtekst") uit `itg_achtergrond` op de Opportunity.
   *
   * Ruwe tekst met regelafbrekingen; de alinea-indeling gebeurt in de opmaaklaag. Leeg is
   * normaal zolang ITG de kolom nog aan het vullen is — hij is op 20-Aug-2026 door ons
   * aangemaakt en begon dus overal leeg.
   */
  readonly achtergrond: string;
  /** Cyclus, huiswerk en voorbereidende opdracht, zoals het agendabord ze aangeeft. */
  readonly opdrachten: BriefingOpdrachten;
  /**
   * De BEVESTIGDE trainingscyclus, of `null`.
   *
   * `null` is de gewone training: geen cycluslabel, geen andere sessies, of een cyclus die nog
   * niemand heeft bevestigd. Alleen dit stuurt het document; zie `bepaalCyclusKeuze`.
   */
  readonly cyclus: BriefingCyclus | null;
  /** De vraag met de vinkjes, of `null` als er geen andere sessies onder de opdracht staan. */
  readonly cyclusKeuze: CyclusKeuze | null;

  /** Lege verplichte velden. Leeg betekent: klaar om te genereren. */
  readonly missing: readonly MissingField[];
}

/** De statuswaarden van `Brie`, letterlijk zoals ze op het bord staan. */
export const BRIE = {
  aanmaken: 'Aanmaken',
  interneTrainer: 'Interne trainer',
  onvolledig: 'Begonnen, niet klaar',
  klaar: 'Staat klaar',
  verzonden: 'Verzonden',
} as const;
