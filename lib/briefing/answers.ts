/**
 * De antwoorden van de adviseur, als pure gegevens.
 *
 * Apart van `checklist-store.ts` omdat **de tab deze vorm ook in de browser nodig heeft**:
 * het scherm rekent zijn eigen voorbeeld opnieuw uit zodra er een vinkje verandert, zonder de
 * server erbij te halen. De store trekt `node:crypto` en de Redis-client mee, en die horen
 * niet in een bundel die naar Monday gaat.
 */

import type { BriefingChecklist } from './blocks';

export const CONCEPT_MAX_LENGTH = 20_000;

/**
 * Wat de adviseur heeft geantwoord.
 *
 * `actorItemIds` is geen vinkje maar een aanwijzing: wélke gekoppelde persoon de acteur is. De
 * groep `Acteurs` op het trainersbord is gemeten incompleet, dus zonder deze lijst is een
 * sessie met een niet-ingedeelde acteur niet te genereren.
 */
export interface SavedChecklist {
  readonly checklist: BriefingChecklist;
  readonly actorItemIds: readonly string[];
  /**
   * Is er een Monday Challenge voor deze training?
   *
   * Niet in `BriefingChecklist`, omdat het geen blok aan- of uitzet maar één harde regel onder
   * de achtergrondinformatie. Dirkje: *"Als deze er is, dan moet je dit altijd achterzetten.
   * Gewoon hard."*
   */
  readonly mondayChallenge: boolean;
  /**
   * Heeft een mens de acteurvraag beantwoord?
   *
   * Expliciet, en niet afgeleid uit "er staat iets opgeslagen". Dat laatste maakte het
   * aanvinken van *huiswerk* stilzwijgend tot een bevestiging van het acteurvoorstel — terwijl
   * het voorstel al als gekozen radioknop op het scherm stond en er dus nooit een
   * `change`-gebeurtenis kwam als de adviseur hetzelfde antwoord aanklikte.
   *
   * Zolang dit `false` is blijft genereren geblokkeerd: het acteurblok verdwijnt anders uit
   * élk document van een sessie mét acteur, zonder dat iemand een vraag heeft overgeslagen.
   */
  readonly actorAnswered: boolean;
}

/** Waar de tab mee opent als er nog niets is opgeslagen. */
export const EMPTY_SAVED: SavedChecklist = {
  checklist: {
    ownGroup: false,
    sameGroup: false,
    trainingCycle: false,
    homework: false,
    preparatoryAssignment: false,
    trainingActor: false,
  },
  actorItemIds: [],
  mondayChallenge: false,
  actorAnswered: false,
};

/**
 * Wat er niet opgeslagen mag worden.
 *
 * "Ieder een eigen groep" en "samen op één groep" zijn de twee antwoorden op dezelfde vraag;
 * `selectBlocks` wérpt erop. Dat mag geen opgeslagen toestand zijn, want dan komt de tab er
 * niet meer uit.
 */
export function validateChecklist(input: SavedChecklist): string | null {
  if (input.checklist.ownGroup && input.checklist.sameGroup) {
    return '"ieder een eigen groep" en "samen op één groep" kunnen niet allebei aanstaan';
  }
  if ((input.checklist.conceptInhoud ?? '').length > CONCEPT_MAX_LENGTH) {
    return `de concept-inhoud mag hoogstens ${CONCEPT_MAX_LENGTH} tekens zijn`;
  }
  if (!input.checklist.trainingActor && input.actorItemIds.length > 0) {
    return 'er is een acteur aangewezen terwijl de acteurvraag op nee staat';
  }
  return null;
}
