import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { sessionFacts } from '../compose';
import { resolveRecipientRoles } from '../recipients';

import type { BriefingTraining } from '../types';

const PROBIBLIO: BriefingTraining = {
  itemId: '1',
  naam: 'Probiblio',
  label: 'IT',
  brie: 'Aanmaken',
  opdrachtgever: 'Probiblio',
  themas: ['Verbindend communiceren'],
  themaInhoud: '',
  klanttitel: 'Verbindend communiceren',
  duur: '3',
  datum: '2026-03-24',
  tijden: '09:30-12:30',
  groepsgrootte: '10-20',
  locatie: 'Valkenburg',
  voertaal: 'NL',
  klantcontactmoment: 'Telefoon',
  evaluatie: 'Geen QR (deze sessie)',
  ieCode: '',
  accountmanager: null,
  contactpersoon: null,
  trainers: [],
  acteuraantal: null,
  opportunityItemId: null,
  achtergrond: '',
  missing: [],
};

const trainer = (id: string, naam: string, isActeur: boolean, isCoTrainer = false) => ({
  itemId: id,
  naam,
  telefoon: '',
  isActeur,
  isCoTrainer,
});

/** De ontvangers met rol `lead` of `co`; de acteurs staan er apart in. */
const trainersOf = (uit: ReturnType<typeof resolveRecipientRoles>): string[] =>
  uit.kind === 'resolved'
    ? uit.recipients.filter((r) => r.role !== 'acteur').map((r) => r.trainer.naam)
    : [];

const roleOf = (uit: ReturnType<typeof resolveRecipientRoles>, naam: string): string =>
  uit.kind === 'resolved'
    ? (uit.recipients.find((r) => r.trainer.naam === naam)?.role ?? 'niet gevonden')
    : uit.kind;

describe('resolveRecipientRoles — wie ontvangt er', () => {
  /** Een acteur krijgt zijn eigen briefing, met zijn eigen tekstblok. */
  it('geeft de acteur terug als ontvanger, met rol acteur', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', true)],
      },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(uit.kind).toBe('resolved');
    expect(trainersOf(uit)).toEqual(['Lennart']);
    expect(roleOf(uit, 'Elke')).toBe('acteur');
  });

  /**
   * Het gemeten randgeval: `Acteuraantal=1`, twee gekoppelde personen, geen van beiden in de
   * groep `Acteurs` — 8 keer op het bord. Eén van de twee is de acteur en welke staat nergens.
   */
  it('weigert rollen toe te wijzen als de acteur niet aan te wijzen is', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', false)],
      },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(uit.kind).toBe('ambiguous');
    expect(uit.kind === 'ambiguous' && uit.actorsUnaccounted).toBe(1);
  });

  it('lost de twijfel op zodra de adviseur de acteur aanwijst', () => {
    const training = {
      ...PROBIBLIO,
      acteuraantal: 1,
      trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', false)],
    };
    const checklist = { ...EMPTY_CHECKLIST, trainingActor: true };
    const uit = resolveRecipientRoles(training, checklist, { actorItemIds: ['2'] });
    expect(trainersOf(uit)).toEqual(['Lennart']);
    expect(roleOf(uit, 'Elke')).toBe('acteur');
    expect(sessionFacts(training, checklist, { actorItemIds: ['2'] })).toEqual({
      certainTrainers: 1,
      identifiedActors: 1,
      unknownRole: 0,
    });
  });

  /**
   * De groep `Acteurs` zegt wat iemand meestal doet, niet welke rol hij in déze sessie heeft.
   * Zegt de adviseur `--geen-acteur`, dan is die persoon hier trainer.
   */
  it('laat het antwoord van de adviseur winnen van de groep Acteurs', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        // Elke staat in de groep Acteurs én in de co-trainerkolom.
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', true, true)],
      },
      EMPTY_CHECKLIST
    );
    expect(trainersOf(uit)).toEqual(['Lennart', 'Elke']);
    expect(roleOf(uit, 'Elke')).toBe('co');
  });
});

describe('resolveRecipientRoles — welke rol', () => {
  it('leest lead en co uit de kolommen, niet uit de volgorde', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Tessa', false, true)],
      },
      EMPTY_CHECKLIST
    );
    expect(roleOf(uit, 'Lennart')).toBe('lead');
    expect(roleOf(uit, 'Tessa')).toBe('co');
  });

  /** Iedere ontvanger ziet de ánderen; dat vult ITG's plaatshouder `Naam (tel nr)`. */
  it('geeft per ontvanger de andere trainers, zonder hemzelf', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Tessa', false, true)],
      },
      EMPTY_CHECKLIST
    );
    const lennart = uit.kind === 'resolved' ? uit.recipients[0] : undefined;
    expect(lennart?.otherTrainers.map((t) => t.naam)).toEqual(['Tessa']);
  });

  it('geeft de acteur de trainers als "anderen", zodat zijn blok ze kan noemen', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', true)],
      },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    const elke = uit.kind === 'resolved' ? uit.recipients.find((r) => r.role === 'acteur') : undefined;
    expect(elke?.otherTrainers.map((t) => t.naam)).toEqual(['Lennart']);
  });

  /**
   * De legacy-toestand van vóór de kolomsplitsing: 65 trainingen op Agenda 2026 met twee of
   * meer mensen in de leadkolom. Het lead- en het co-blok spreken elkaar tegen, dus gokken is
   * hier de dure fout.
   */
  it('weigert als er twee mensen in de leadkolom staan', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Tessa', false)],
      },
      EMPTY_CHECKLIST
    );
    expect(uit.kind).toBe('no_single_lead');
    expect(uit.kind === 'no_single_lead' && uit.leadCandidates.map((t) => t.naam)).toEqual([
      'Lennart',
      'Tessa',
    ]);
  });

  /**
   * Nul leads is stiller dan twee en daarom gevaarlijker: elk document verwijst dan naar een
   * leadtrainer die niet bestaat. De co-trainer krijgt `n.v.t., door lead trainer` bij
   * Klantcontactmoment, en een co die alléén overblijft krijgt zelfs geen rolblok — er zijn
   * immers geen "andere trainers" om te noemen. Nergens staat dan dat het klantcontact bij
   * niemand ligt.
   */
  it('weigert als iedereen in de co-kolom staat', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        trainers: [trainer('1', 'Lennart', false, true), trainer('2', 'Tessa', false, true)],
      },
      EMPTY_CHECKLIST
    );
    expect(uit.kind).toBe('no_single_lead');
    expect(uit.kind === 'no_single_lead' && uit.leadCandidates).toEqual([]);
  });

  it('weigert bij één co-trainer zonder lead', () => {
    const uit = resolveRecipientRoles(
      { ...PROBIBLIO, trainers: [trainer('1', 'Tessa', false, true)] },
      EMPTY_CHECKLIST
    );
    expect(uit.kind).toBe('no_single_lead');
  });

  /** De enige trainer is als acteur aangemerkt: dan blijft er niemand over om te leiden. */
  it('weigert als de enige niet-co-trainer de acteur is', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        trainers: [trainer('1', 'Elke', true), trainer('2', 'Tessa', false, true)],
      },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(uit.kind).toBe('no_single_lead');
    expect(uit.kind === 'no_single_lead' && uit.leadCandidates).toEqual([]);
  });

  it('weigert als er helemaal niemand gekoppeld is', () => {
    const uit = resolveRecipientRoles({ ...PROBIBLIO, trainers: [] }, EMPTY_CHECKLIST);
    expect(uit.kind).toBe('no_single_lead');
  });

  /** Eén trainer zonder co-trainers is gewoon de lead; er is niets te kiezen. */
  it('wijst één enkele trainer aan als lead', () => {
    const uit = resolveRecipientRoles(
      { ...PROBIBLIO, trainers: [trainer('1', 'Lennart', false)] },
      EMPTY_CHECKLIST
    );
    expect(roleOf(uit, 'Lennart')).toBe('lead');
  });

  /**
   * Een acteur telt niet mee voor de leadkeuze: één trainer plus een acteur heeft gewoon een
   * lead. Zou hij wél meetellen, dan viel elke sessie met acteur om op `no_single_lead`.
   */
  it('telt de acteur niet mee als leadkandidaat', () => {
    const uit = resolveRecipientRoles(
      {
        ...PROBIBLIO,
        acteuraantal: 1,
        trainers: [trainer('1', 'Lennart', false), trainer('2', 'Elke', true)],
      },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(uit.kind).toBe('resolved');
    expect(roleOf(uit, 'Lennart')).toBe('lead');
  });
});
