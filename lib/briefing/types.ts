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
}

/**
 * De ruwe gegevens van één training, vóór opmaak.
 *
 * Alles is een string omdat de briefing tekst is; het omzetten naar de zinnen die in het
 * document staan gebeurt in de opmaaklaag, niet hier. Zo blijft dit testbaar tegen wat
 * Monday werkelijk teruggeeft.
 */
export interface BriefingTraining {
  readonly itemId: string;
  readonly naam: string;
  /** Labelafkorting uit `status23`, bv. `IT`. Bepaalt welk sjabloon en welke huisstijl. */
  readonly label: string;
  readonly brie: string;

  readonly opdrachtgever: string;
  readonly themas: readonly string[];
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
