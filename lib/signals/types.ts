import type { LabelCode } from '@lib/labels';

/**
 * Wat de dagelijkse controle kan vinden.
 *
 * Elke variant draagt het AANTAL TRAININGEN mee. Dat is niet alleen voor de leesbaarheid van
 * de melding: de controle meldt alleen wat daadwerkelijk in gebruik is (zie `findings.ts`),
 * dus het getal is ook het bewijs dat de melding ergens over gaat. Een label dat op nul
 * trainingen staat breekt niets en hoort niemand wakker te maken.
 */
/** Een kolom van ons die op een agendabord ontbreekt of van type is veranderd. */
export interface OntbrekendeKolom {
  readonly id: string;
  readonly titel: string;
  /** Wat er zonder deze kolom niet werkt, als zinsdeel: "de briefing". */
  readonly voor: string;
  /** De opdracht die hem op DIT bord aanmaakt, met dezelfde kolom-id en `--board`. */
  readonly script: string;
  /** `ontbreekt`, of het type dat er wél staat. */
  readonly probleem: string;
}

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
    }
  /**
   * Een agendabord dat voor het eerst meedoet, zoals een gedupliceerde nieuwe jaargang.
   *
   * Geen fout maar een seintje: ontdekken gebeurt vanzelf, en zonder deze melding merkt niemand
   * dat er een bord bij is gekomen, ook niet als het een testkopie is die er niet hoort.
   */
  | {
      readonly kind: 'agendabord-nieuw';
      readonly boardId: string;
      readonly naam: string;
      readonly gearchiveerd: boolean;
    }
  /**
   * Een actief agendabord waar de aanbevelingen niet werken.
   *
   * Zonder deze melding sleept iemand een training naar Inplannen en gebeurt er niets. Meestal
   * ontbreekt onze statuskolom; op Agenda 2025 is dat bewust zo.
   */
  | {
      readonly kind: 'aanbevelingen-niet-aangesloten';
      readonly boardId: string;
      readonly naam: string;
      readonly reden: string;
    }
  /**
   * Een actief agendabord zonder een of meer kolommen die wíj hebben aangemaakt.
   *
   * Die staan alleen op de borden waar we ze op hebben gezet. Een jaargang die als kopie is
   * gemaakt vóór zo'n kolom bestond, of die later met ons gedeeld wordt, mist ze — en dan
   * faalt de briefing of het wegschrijven van de evaluatie op dat bord.
   */
  | {
      readonly kind: 'kolommen-ontbreken';
      readonly boardId: string;
      readonly naam: string;
      /** Per ontbrekende kolom: welke kolom, wat erdoor stuk gaat, en hoe hij erop komt. */
      readonly kolommen: readonly OntbrekendeKolom[];
    }
  /** Een bord dat op een agenda lijkt, maar niet te gebruiken is, en dus nergens aan meedoet. */
  | {
      readonly kind: 'agendabord-onbruikbaar';
      readonly boardId: string;
      readonly naam: string;
      readonly reden: string;
    }
  /**
   * Een evaluatiemail die de deur niet uit is gekomen.
   *
   * De enige variant die NIET over ITG's gegevens gaat maar over een storing bij ons, en de
   * enige die niet uit een bordscan komt: de rapportagejob laat hem achter in KV en deze
   * controle raapt hem op. Zie `lib/mail/failure-store.ts` voor waarom dat via KV loopt en
   * niet rechtstreeks naar het bord.
   *
   * Draagt geen `trainingen`, want het gaat over één specifieke training — het getal dat de
   * andere varianten meedragen is er juist om te bewijzen dát een melding ergens over gaat, en
   * hier is dat de training zelf.
   */
  | {
      readonly kind: 'mail-mislukt';
      readonly itemId: string;
      readonly variant: 'met' | 'zonder';
      readonly klanttitel: string;
      readonly datum: string;
      readonly reden: string;
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
    /**
     * De variant hoort in de sleutel.
     *
     * Een training kan eerst als `zonder` mislukken en later, als de reacties alsnog binnen
     * zijn, als `met`. Dat zijn twee verschillende mails en dus twee meldingen; op alleen het
     * item-id zou de tweede de eerste overschrijven.
     */
    case 'mail-mislukt':
      return `mail-mislukt:${finding.itemId}:${finding.variant}`;
    // Op bord-id: een hernoemd bord is hetzelfde bord.
    case 'agendabord-nieuw':
      return `agendabord-nieuw:${finding.boardId}`;
    case 'agendabord-onbruikbaar':
      return `agendabord-onbruikbaar:${finding.boardId}`;
    case 'aanbevelingen-niet-aangesloten':
      return `aanbevelingen-niet-aangesloten:${finding.boardId}`;
    case 'kolommen-ontbreken':
      return `kolommen-ontbreken:${finding.boardId}`;
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
