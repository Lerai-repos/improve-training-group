import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { BRIEFING_AGENDA_COLUMNS } from '../columns';
import { buildTabView } from '../tab';

import type { SavedChecklist } from '../answers';
import type { BriefingTraining } from '../types';

/**
 * Wat het scherm van de adviseur toont.
 *
 * De nadruk ligt op de gevallen die op het bord zeldzaam zijn en in de tab dagelijks: een
 * training zonder leadtrainer, een acteur die niemand kan aanwijzen, en het verschil tussen
 * "de vraag is niet beantwoord" en "het antwoord is nee".
 */

const TRAINING: BriefingTraining = {
  itemId: '900',
  naam: 'Welzijn Ermelo',
  label: 'JE',
  brie: 'Aanmaken',
  opdrachtgever: 'Welzijn Ermelo',
  themas: ['Improvisatietheater'],
  trainingscodeMc: '',
  themaInhoud: 'Plenaire opening.\nOefenen bij {organisatie}.',
  klanttitel: 'Improvisatietheater',
  duur: '2',
  datum: '2026-10-09',
  tijden: '14:00-16:00',
  groepsgrootte: '30',
  locatie: 'Raadhuisplein 6, Ermelo',
  voertaal: 'NL',
  klantcontactmoment: 'Telefoon',
  evaluatie: 'Nee',
  ieCode: '',
  accountmanager: null,
  contactpersoon: null,
  trainers: [
    { itemId: '1', naam: 'Frank Paats', telefoon: '', isActeur: false, isCoTrainer: false },
    { itemId: '2', naam: 'Richard Roling', telefoon: '', isActeur: false, isCoTrainer: true },
  ],
  acteuraantal: null,
  opportunityItemId: null,
  achtergrond: 'Iets over de klant.',
  missing: [],
};

const opgeslagen = (over: Partial<SavedChecklist> = {}): SavedChecklist => ({
  checklist: EMPTY_CHECKLIST,
  actorItemIds: [],
  actorAnswered: true,
  ...over,
});

describe('buildTabView', () => {
  it('toont welke documenten er zouden komen, met rol', () => {
    const uit = buildTabView(TRAINING, opgeslagen());
    expect(uit.documenten).toEqual([
      { itemId: '1', naam: 'Frank Paats', role: 'lead' },
      { itemId: '2', naam: 'Richard Roling', role: 'co' },
    ]);
    expect(uit.kanGenereren).toBe(true);
  });

  /**
   * Het scherm zet de acteurvraag vóór met wat Monday suggereert, maar mag dat niet als
   * antwoord tellen. Zou een onaangeraakte tab `nee` betekenen, dan verdwijnt het acteurblok
   * uit elk document van een sessie mét acteur zonder dat iemand een vraag oversloeg.
   */
  it('houdt "niet beantwoord" en "nee" uit elkaar', () => {
    const metActeur = { ...TRAINING, acteuraantal: 1 };
    const nieuw = buildTabView(metActeur, null);
    expect(nieuw.acteurBeantwoord).toBe(false);
    expect(nieuw.acteurVoorstel).toBe(true);
    expect(nieuw.checklist.trainingActor).toBe(true);

    const geantwoord = buildTabView(metActeur, opgeslagen());
    expect(geantwoord.acteurBeantwoord).toBe(true);
    expect(geantwoord.checklist.trainingActor).toBe(false);
  });

  /**
   * De legacy-toestand van vóór de kolomsplitsing: 65 trainingen met twee mensen in de
   * leadkolom. Het lead- en het co-blok beweren het tegenovergestelde over wie het
   * klantcontact doet, dus hier gokken is de dure fout.
   */
  it('blokkeert bij twee mensen in de leadkolom, met de handeling erbij', () => {
    const twee = {
      ...TRAINING,
      trainers: [
        { itemId: '1', naam: 'Frank Paats', telefoon: '', isActeur: false, isCoTrainer: false },
        { itemId: '2', naam: 'Richard Roling', telefoon: '', isActeur: false, isCoTrainer: false },
      ],
    };
    const uit = buildTabView(twee, opgeslagen());
    expect(uit.kanGenereren).toBe(false);
    const issue = uit.issues.find((i) => i.kind === 'geen_lead');
    expect(issue?.tekst).toContain('kolom Co-trainer(s)');
    expect(uit.documenten).toEqual([]);
  });

  it('blokkeert als er niemand in de leadkolom staat', () => {
    const geen = {
      ...TRAINING,
      trainers: [
        { itemId: '2', naam: 'Richard Roling', telefoon: '', isActeur: false, isCoTrainer: true },
      ],
    };
    const uit = buildTabView(geen, opgeslagen());
    expect(uit.issues.find((i) => i.kind === 'geen_lead')?.tekst).toContain('geen leadtrainer');
  });

  /**
   * "Er staat niemand in de leadkolom" en "Trainer is leeg" zijn hetzelfde feit in twee
   * zinnen. Naast elkaar op één scherm lezen ze als twee losse problemen, en de tweede
   * voegt niets toe: alleen de eerste zegt wat je eraan doet.
   */
  it('meldt een lege trainerkolom één keer, niet ook als leeg veld', () => {
    const geen = {
      ...TRAINING,
      trainers: [],
      missing: [
        { column: BRIEFING_AGENDA_COLUMNS.trainerRelation, label: 'Trainer' },
        { column: 'itg_achtergrond', label: 'Achtergrondinformatie' },
      ],
    };

    const uit = buildTabView(geen, opgeslagen());

    expect(uit.issues.filter((i) => i.kind === 'geen_lead')).toHaveLength(1);
    // De achtergrondinformatie is een ander veld en blijft gewoon gemeld.
    expect(uit.issues.filter((i) => i.kind === 'veld_leeg').map((i) => i.tekst)).toEqual([
      'Achtergrondinformatie is leeg; dat wordt een zichtbare regel in het document',
    ]);
  });

  /** Zonder dat blokkerende geval blijft de trainermelding wél staan. */
  it('meldt een leeg trainerveld wel als er gewoon een leadtrainer is', () => {
    const uit = buildTabView(
      {
        ...TRAINING,
        missing: [{ column: BRIEFING_AGENDA_COLUMNS.trainerRelation, label: 'Trainer' }],
      },
      opgeslagen()
    );

    expect(uit.issues.some((i) => i.kind === 'geen_lead')).toBe(false);
    expect(uit.issues.find((i) => i.kind === 'veld_leeg')?.tekst).toContain('Trainer');
  });

  /** Het gemeten randgeval: `Acteuraantal` belooft iemand die nergens als acteur staat. */
  it('vraagt om een acteur aan te wijzen als er niet uit te komen valt', () => {
    const uit = buildTabView(
      { ...TRAINING, acteuraantal: 1 },
      opgeslagen({ checklist: { ...EMPTY_CHECKLIST, trainingActor: true } })
    );
    expect(uit.kanGenereren).toBe(false);
    expect(uit.issues.find((i) => i.kind === 'acteur_onbekend')?.tekst).toContain(
      'Wijs hieronder aan'
    );
  });

  it('lost dat op zodra de adviseur er een aanwijst', () => {
    const uit = buildTabView(
      { ...TRAINING, acteuraantal: 1 },
      opgeslagen({
        checklist: { ...EMPTY_CHECKLIST, trainingActor: true },
        actorItemIds: ['2'],
      })
    );
    expect(uit.kanGenereren).toBe(true);
    expect(uit.documenten.find((d) => d.itemId === '2')?.role).toBe('acteur');
    expect(uit.personen.find((p) => p.itemId === '2')?.aangewezenAlsActeur).toBe(true);
  });

  it('weigert een training waar Brie op "Interne trainer" staat', () => {
    const uit = buildTabView({ ...TRAINING, brie: 'Interne trainer' }, opgeslagen());
    expect(uit.kanGenereren).toBe(false);
    expect(uit.issues.some((i) => i.kind === 'interne_trainer')).toBe(true);
  });

  /**
   * Dirkje's eigen wens was *"joh, er ontbreekt nog informatie"* — melden dus, niet
   * tegenhouden. Het document komt er wel, met een zichtbare regel op de lege plek.
   */
  it('meldt lege velden zonder te blokkeren', () => {
    const uit = buildTabView(
      {
        ...TRAINING,
        missing: [{ column: 'itg_achtergrond', label: 'Achtergrondinformatie' }],
      },
      opgeslagen()
    );
    expect(uit.kanGenereren).toBe(true);
    const issue = uit.issues.find((i) => i.kind === 'veld_leeg');
    expect(issue?.blokkeert).toBe(false);
    expect(issue?.tekst).toContain('Achtergrondinformatie');
  });

  it('vult het tekstvak voor met het skelet van het thema', () => {
    const uit = buildTabView(TRAINING, opgeslagen());
    expect(uit.conceptSkelet).toEqual(['Plenaire opening.', 'Oefenen bij {organisatie}.']);
    expect(uit.conceptEigen).toBeNull();
  });

  /** De klantnaam komt uit de Bedrijf-mirror; het scherm toont wat er écht in komt te staan. */
  it('toont het resultaat met de organisatienaam ingevuld', () => {
    const uit = buildTabView(TRAINING, opgeslagen());
    expect(uit.conceptResultaat).toEqual(['Plenaire opening.', 'Oefenen bij Welzijn Ermelo.']);
  });

  /**
   * Aangeraakt betekent: de tekst van de adviseur wint. Onaangeraakt betekent: gebruik het
   * skelet, zodat een verbeterd skelet elke volgende briefing bereikt in plaats van dat elke
   * training een kopie bevriest op de dag dat iemand hem toevallig opendeed.
   */
  it('laat de eigen tekst van de adviseur winnen van het skelet', () => {
    const uit = buildTabView(
      TRAINING,
      opgeslagen({ checklist: { ...EMPTY_CHECKLIST, conceptInhoud: 'Alleen dit.' } })
    );
    expect(uit.conceptEigen).toBe('Alleen dit.');
    expect(uit.conceptResultaat).toEqual(['Alleen dit.']);
    expect(uit.conceptSkelet).toEqual(['Plenaire opening.', 'Oefenen bij {organisatie}.']);
  });
});
