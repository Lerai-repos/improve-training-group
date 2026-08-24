/**
 * Wie de briefing krijgt, en in welke rol.
 *
 * Dirkje, 21-Aug-2026: *"De briefing gaat naar mensen persoonlijk (staan ook hun eigen km's
 * bijv in). Dus ze krijgen de tekst idd obv hun rol."* Eén sessie met een lead, een co en een
 * acteur levert dus **drie documenten** op, elk met een andere tekst.
 *
 * Dat is niet cosmetisch. De blokken `Leadtrainer` en `Co-trainer` beweren het
 * tegenovergestelde over wie het klantcontact doet: sturen we de verkeerde, dan denken twee
 * mensen dat zíj de klant bellen, of denkt niemand het.
 *
 * ## Waar de rol vandaan komt
 *
 * Sinds 21-Aug-2026 draagt `board_relation_mkz4y7tb` de leadtrainer en `itg_cotrainers` de
 * co-trainers, dus de rol is een **feit van het bord** in plaats van een gok. Daarvoor werd
 * hij afgeleid uit de koppelvolgorde, en Dirkje over hoe dat ging: *"Peter geeft vaak aan in
 * de updates wie de lead trainer is. Maar dit gaat vaak niet goed."*
 *
 * Een acteur herkennen we aan de **persoon** en niet aan de kolom — staat hij in de groep
 * `Acteurs` op het trainersbord, of wijst de adviseur hem aan, dan is hij de acteur. In welke
 * van de twee relatiekolommen ITG hem zet doet er dus niet toe.
 */

import type { BriefingChecklist } from './blocks';
import type { BriefingTrainer, BriefingTraining } from './types';

/** Wie de adviseur zelf als acteur heeft aangewezen, per item-id op het trainersbord. */
export interface RoleOverrides {
  readonly actorItemIds?: readonly string[];
}

export type RecipientRole = 'lead' | 'co' | 'acteur';

/** Eén ontvanger, met alles wat zijn eigen document nodig heeft. */
export interface Recipient {
  readonly trainer: BriefingTrainer;
  readonly role: RecipientRole;
  /**
   * De **andere** trainers, gezien vanuit deze ontvanger — dus zonder hemzelf en zonder de
   * acteurs. Dit vult ITG's plaatshouder `Naam (tel nr)` in het lead- en co-trainerblok.
   */
  readonly otherTrainers: readonly BriefingTrainer[];
  /** De acteurs van deze sessie. Vult dezelfde plaatshouder in de acteurblokken. */
  readonly actors: readonly BriefingTrainer[];
}

/**
 * De gekoppelde personen ingedeeld naar rol, met de onbeslisbare gevallen apart.
 *
 * **De checklist wint van Monday.** Zegt de adviseur dat er geen acteur meewerkt, dan is
 * iedereen trainer — ook iemand die in de groep `Acteurs` staat. Die groep zegt wat iemand
 * meestal doet, niet welke rol hij in déze sessie heeft.
 */
export function classify(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  overrides: RoleOverrides
): { actors: BriefingTrainer[]; others: BriefingTrainer[]; unaccounted: number } {
  if (!checklist.trainingActor) {
    return { actors: [], others: [...training.trainers], unaccounted: 0 };
  }
  const aangewezen = new Set(overrides.actorItemIds ?? []);
  const actors = training.trainers.filter((t) => t.isActeur || aangewezen.has(t.itemId));
  const others = training.trainers.filter((t) => !actors.includes(t));
  const expected = Math.max(training.acteuraantal ?? 1, 1);
  return {
    actors,
    others,
    unaccounted: Math.min(Math.max(0, expected - actors.length), others.length),
  };
}

export type RecipientRoles =
  | { readonly kind: 'resolved'; readonly recipients: readonly Recipient[] }
  /** `Acteuraantal` belooft meer acteurs dan er aan te wijzen zijn. */
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly BriefingTrainer[];
      readonly actorsUnaccounted: number;
    }
  /**
   * Er is niet precies één leadtrainer aan te wijzen — er zijn er twee of meer, of geen.
   *
   * **Twee of meer** is de legacy-toestand van vóór de kolomsplitsing: gemeten 65 trainingen
   * op Agenda 2026, waarvan er 52 al geweest zijn. Tim, 21-Aug-2026: *"we will do that when
   * we get to it, they probably already started the briefings, so lets keep it like this for
   * now."* Gokken is hier de dure fout, want het lead- en het co-blok spreken elkaar tegen.
   *
   * **Geen** betekent dat iedereen in de co-kolom staat, of dat de enige persoon in de
   * leadkolom als acteur is geclassificeerd. Elk document verwijst dan naar een lead die niet
   * bestaat, en er staat nergens dat het klantcontact bij niemand ligt.
   *
   * `leadCandidates` is dus leeg óf heeft er twee of meer; nooit precies één.
   */
  | { readonly kind: 'no_single_lead'; readonly leadCandidates: readonly BriefingTrainer[] };

/**
 * De ontvangers met hun rol, of de reden waarom dat niet te bepalen is.
 *
 * De acteurs krijgen zelf ook een briefing: `resolveRecipientRoles` geeft ze terug als
 * ontvanger mét rol `acteur`, want ITG heeft daar een eigen tekstblok voor
 * (`Werken als trainingsacteur`).
 */
export function resolveRecipientRoles(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  overrides: RoleOverrides = {}
): RecipientRoles {
  const { actors, others, unaccounted } = classify(training, checklist, overrides);
  if (unaccounted > 0) {
    return { kind: 'ambiguous', candidates: others, actorsUnaccounted: unaccounted };
  }

  /**
   * De lead is wie in de leadkolom staat en géén acteur is. **Precies één**, en niet
   * "hoogstens één".
   *
   * Twee is de legacy-toestand: de kolom is nog niet gesplitst en er valt niets te kiezen.
   *
   * **Nul is erger**, en dat is niet meteen te zien. Staat iedereen in de co-kolom, of is de
   * enige persoon in de leadkolom als acteur geclassificeerd, dan verwijst élk document naar
   * een leadtrainer die niet bestaat: co-trainer en acteur krijgen `n.v.t., door lead
   * trainer` bij Klantcontactmoment, en een co-trainer die alléén overblijft krijgt zelfs
   * geen rolblok, want er zijn geen "andere trainers" om te noemen. Er staat dan nergens dat
   * het klantcontact bij niemand ligt.
   *
   * Dirkje's regel is er ook stellig over: *"iemand moet altijd de lead hebben."*
   */
  const leads = others.filter((t) => !t.isCoTrainer);
  if (leads.length !== 1) {
    return { kind: 'no_single_lead', leadCandidates: leads };
  }

  /**
   * Geen lead in de kolom en tóch trainers? Dan staat iedereen als co-trainer, en doet
   * niemand het klantcontact. Dat kán niet volgens Dirkje's regel *"iemand moet altijd de
   * lead hebben"*, maar het bord kan het wél zo bevatten. De co-tekst is dan de eerlijke
   * keuze: die verwijst naar een leadtrainer, en dat die ontbreekt valt op.
   */
  const trainerRecipients: Recipient[] = others.map((trainer) => ({
    trainer,
    role: trainer.isCoTrainer ? 'co' : 'lead',
    otherTrainers: others.filter((o) => o.itemId !== trainer.itemId),
    actors,
  }));

  const actorRecipients: Recipient[] = actors.map((trainer) => ({
    trainer,
    role: 'acteur',
    /** Een acteur leest wie de (lead)trainer is, dus dat zijn hier álle trainers. */
    otherTrainers: others,
    actors: actors.filter((a) => a.itemId !== trainer.itemId),
  }));

  return { kind: 'resolved', recipients: [...trainerRecipients, ...actorRecipients] };
}

/** `Lennart Bosschaart (06-18683139), Tessa de Haas (06-24118840)` */
export function nameList(
  trainers: readonly BriefingTrainer[],
  format: (naam: string, telefoon: string) => string
): string {
  return trainers
    .map((t) => format(t.naam, t.telefoon))
    .filter((label) => label !== '')
    .join(', ');
}
