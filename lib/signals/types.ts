import type { LabelCode } from '@lib/labels';

/**
 * Wat de dagelijkse controle kan vinden.
 *
 * Elke variant draagt het AANTAL TRAININGEN mee. Dat is niet alleen voor de leesbaarheid van
 * de melding: de controle meldt alleen wat daadwerkelijk in gebruik is (zie `findings.ts`),
 * dus het getal is ook het bewijs dat de melding ergens over gaat. Een label dat op nul
 * trainingen staat breekt niets en hoort niemand wakker te maken.
 */
export type Finding =
  /** Een labelwaarde op de agenda die door geen enkele code of alias wordt herkend. */
  | { readonly kind: 'onbekend-label'; readonly label: string; readonly trainingen: number }
  /** De code is bekend, maar er staat geen rij voor op het Labels-bord. */
  | { readonly kind: 'label-ontbreekt'; readonly code: LabelCode; readonly trainingen: number }
  /** De rij bestaat, maar een veld dat wél gelezen wordt is onbruikbaar. */
  | {
      readonly kind: 'label-onvolledig';
      readonly code: LabelCode;
      readonly velden: readonly LabelFieldIssue[];
      readonly trainingen: number;
    }
  /** Een training verwijst naar een thema-item dat niet meer bestaat. */
  | { readonly kind: 'thema-ontbreekt'; readonly themaId: string; readonly trainingen: number }
  /** Een training verwijst naar een trainer-item dat niet meer bestaat. */
  | { readonly kind: 'trainer-ontbreekt'; readonly trainerId: string; readonly trainingen: number }
  /** Het thema bestaat, maar de kolom Concept inhoud is leeg. */
  | {
      readonly kind: 'thema-zonder-inhoud';
      readonly themaId: string;
      readonly naam: string;
      readonly trainingen: number;
    };

/**
 * Eén onbruikbaar veld, mét de reden.
 *
 * De reden hoort erbij en niet alleen de veldnaam: "vul dit veld in" is geen bruikbare
 * instructie voor een kleur waar `blauw` in staat. En hij moet doorwerken tot in de itemnaam,
 * want die is de vingerafdruk waarop `reconcile` een wijziging ziet — gaat een veld van leeg
 * naar ongeldig, dan hoort de melding bijgewerkt te worden.
 */
export interface LabelFieldIssue {
  readonly veld: string;
  readonly reden: 'leeg' | 'ongeldig';
}

export type FindingKind = Finding['kind'];

/**
 * De sleutel waarop een melding zichzelf herkent tussen de runs door.
 *
 * **Op id, nooit op naam.** Een thema hernoemen mag geen tweede melding opleveren en mag een
 * afgevinkte melding niet laten terugkomen; dat is dezelfde regel als overal in deze codebase
 * (`08-valkuilen.md`: hernoemen is veilig, want we werken op id's). Bij een label ÍS de code
 * de identiteit — die staat in de kolomwaarde zelf, niet als item-id.
 */
export function findingKey(finding: Finding): string {
  switch (finding.kind) {
    case 'onbekend-label':
      return `onbekend-label:${finding.label}`;
    case 'label-ontbreekt':
      return `label-ontbreekt:${finding.code}`;
    case 'label-onvolledig':
      return `label-onvolledig:${finding.code}`;
    case 'thema-ontbreekt':
      return `thema-ontbreekt:${finding.themaId}`;
    case 'trainer-ontbreekt':
      return `trainer-ontbreekt:${finding.trainerId}`;
    case 'thema-zonder-inhoud':
      return `thema-zonder-inhoud:${finding.themaId}`;
  }
}

/**
 * Een rij zoals hij op het bord hoort te staan.
 *
 * `reconcile` werkt hierop en niet op `Finding`, zodat er precies één mechaniek is voor alles
 * wat op het bord kan staan. Een mislukte controle krijgt daardoor dezelfde levensloop als een
 * vondst — plaatsen, bijwerken, heropenen, afvinken — in plaats van een tweede, half zo goede
 * kopie ervan.
 */
export interface DesiredRow {
  readonly key: string;
  readonly naam: string;
  readonly detail: string;
  readonly onderdeel: string;
  readonly soort: Soort;
  /**
   * Telt een gewijzigd Detail óók als "er is iets veranderd"?
   *
   * Standaard niet: bij een vondst is het Detail de plek waar een mens een aantekening
   * achterlaat, en die elke nacht terugzetten is erger dan een regel die achterloopt. De
   * itemnaam draagt daar alle veranderlijke waarden, dus die volstaat als vingerafdruk.
   *
   * Bij een storingsrij ligt het omgekeerd: de naam is met opzet stabiel (foutteksten wisselen
   * per poging), niemand annoteert een tijdelijke systeemrij, en het Detail bevat juist het
   * enige dat verandert — de laatste foutmelding. Zonder deze vlag blijft daar dagenlang een
   * achterhaalde fout staan onder het kopje "laatste".
   */
  readonly refreshDetail: boolean;
}

/** De soort van een melding — de labels van de statuskolom `Soort` op het Systeem-bord. */
export type Soort = 'Foutmelding' | 'Signalering' | 'Dagsamenvatting';

/**
 * Welke soort een vondst krijgt.
 *
 * `Signalering` voor alles wat de controle vindt: het zijn toestanden van ITG's gegevens, geen
 * storingen van ons systeem. `Foutmelding` is voorbehouden aan een controle die zélf niet kon
 * draaien — dat moet zichtbaar anders zijn, want dan weet je juist NIET of er iets mis is.
 */
export const FINDING_SOORT: Soort = 'Signalering';
