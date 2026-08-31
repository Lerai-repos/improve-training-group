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

/** Dezelfde training, maar met precies één gekoppeld persoon: 221 van de 265 op het bord. */
const SOLO: BriefingTraining = {
  ...TRAINING,
  trainers: [
    { itemId: '1', naam: 'Frank Paats', telefoon: '', isActeur: false, isCoTrainer: false },
  ],
};

/**
 * Eén trainer: twee vragen die niet te beantwoorden zijn.
 *
 * `Meerdere trainers op deze sessie` gaat over het verdelen van groepen tussen trainers, en
 * de acteurvraag kán met één gekoppeld persoon niet op "ja" uitkomen — `classify` houdt dan
 * óf een onverklaarde acteur over, óf maakt van de enige persoon de acteur en dan is er geen
 * lead. Beide blokkeren. Ze wegnemen scheelt twee vragen op 83% van het bord.
 */
describe('buildTabView met één trainer', () => {
  it('meldt dat de twee vragen niet van toepassing zijn', () => {
    expect(buildTabView(SOLO, opgeslagen()).soloTrainer).toBe(true);
    expect(buildTabView(TRAINING, opgeslagen()).soloTrainer).toBe(false);
  });

  it('zet de acteurvraag en de groepskeuze op nee, wat er ook opgeslagen staat', () => {
    const uit = buildTabView(SOLO, {
      checklist: { ...EMPTY_CHECKLIST, trainingActor: true, ownGroup: true },
      actorItemIds: ['1'],
      actorAnswered: true,
    });

    expect(uit.checklist.trainingActor).toBe(false);
    expect(uit.checklist.ownGroup).toBe(false);
    expect(uit.checklist.sameGroup).toBe(false);
  });

  /** Anders blijft de knop uit op een vraag die het scherm niet meer stelt. */
  it('blokkeert niet op een onbeantwoorde acteurvraag', () => {
    const uit = buildTabView(SOLO, {
      checklist: EMPTY_CHECKLIST,
      actorItemIds: [],
      actorAnswered: false,
    });

    expect(uit.issues.filter((i) => i.blokkeert).map((i) => i.kind)).not.toContain(
      'acteur_onbeantwoord'
    );
    expect(uit.kanGenereren).toBe(true);
  });

  /**
   * Behalve wanneer Monday wél een acteur belooft. Gemeten: 4 van de 265.
   *
   * Die zijn vandaag geblokkeerd, en dat hoort zo te blijven — stilzwijgend "nee" aannemen
   * levert een briefing op zonder acteurblok voor een sessie die er waarschijnlijk wel een
   * heeft. Het verschil is dat er nu staat wát eraan te doen is, in plaats van een vraag die
   * met één gekoppeld persoon geen goed antwoord heeft.
   */
  it('blokkeert wél als Acteuraantal een acteur belooft die niemand is', () => {
    const uit = buildTabView({ ...SOLO, acteuraantal: 1 }, opgeslagen());

    const blokkerend = uit.issues.filter((i) => i.blokkeert);
    expect(blokkerend.map((i) => i.kind)).toContain('acteur_niet_gekoppeld');
    expect(uit.kanGenereren).toBe(false);
    expect(blokkerend[0].tekst).toContain('Acteuraantal');
  });

  /**
   * Eén gekoppeld persoon die in de groep Acteurs staat is GEEN solo-trainer.
   *
   * `training.trainers` bevat trainers én acteurs. Zou de sluiproute ook hier gelden, dan
   * gaat `trainingActor` op nee, telt de acteur als gewone trainer en promoveert
   * `classify` hem tot leadtrainer — waarna er een leadbriefing naar een acteur gaat, met
   * het klantcontact en de inhoudelijke verantwoordelijkheid erin. Op dit bord komt het
   * (nog) niet voor; gemeten 0 van 265. Dat is geen reden om het te laten kunnen.
   */
  it('ziet één acteur niet aan voor een solo-trainer', () => {
    const alleenActeur: BriefingTraining = {
      ...SOLO,
      trainers: [
        { itemId: '9', naam: 'Sam Speler', telefoon: '', isActeur: true, isCoTrainer: false },
      ],
    };

    const onaangeraakt = buildTabView(alleenActeur, {
      checklist: EMPTY_CHECKLIST,
      actorItemIds: [],
      actorAnswered: false,
    });

    expect(onaangeraakt.soloTrainer).toBe(false);
    // De vraag wordt gestéld in plaats van aangenomen, en Monday stelt "ja" voor.
    expect(onaangeraakt.acteurVoorstel).toBe(true);
    expect(onaangeraakt.kanGenereren).toBe(false);
    expect(onaangeraakt.issues.filter((i) => i.blokkeert).map((i) => i.kind)).toContain(
      'acteur_onbeantwoord'
    );
  });

  /**
   * Zegt de adviseur daarna toch "ja", dan is er niemand over om lead te zijn.
   *
   * Dat is de uitkomst die de sluiproute onbereikbaar maakte: met `trainingActor` vast op
   * nee telde de acteur als gewone trainer en werd hij lead.
   */
  it('blokkeert op "geen lead" zodra de acteur als acteur is bevestigd', () => {
    const alleenActeur: BriefingTraining = {
      ...SOLO,
      trainers: [
        { itemId: '9', naam: 'Sam Speler', telefoon: '', isActeur: true, isCoTrainer: false },
      ],
    };

    const uit = buildTabView(alleenActeur, {
      checklist: { ...EMPTY_CHECKLIST, trainingActor: true },
      actorItemIds: [],
      actorAnswered: true,
    });

    expect(uit.kanGenereren).toBe(false);
    expect(uit.issues.filter((i) => i.blokkeert).map((i) => i.kind)).toContain('geen_lead');
  });

  /**
   * De twee beslissingen zijn niet dezelfde beslissing.
   *
   * Bij één gekoppeld persoon uit de groep Acteurs blijft de acteurvraag staan — die moet
   * beantwoord worden. Maar "meerdere trainers op deze sessie" gaat óók dan nergens over:
   * er is één persoon. Hingen ze aan één vlag, dan bleef de groepskeuze zichtbaar én
   * ongemoeid, en kon een oude of nieuw aangevinkte waarde "Ieder een eigen groep" in de
   * briefing van een eenpitter zetten.
   */
  it('wist de groepskeuze ook wanneer die ene persoon een acteur is', () => {
    const alleenActeur: BriefingTraining = {
      ...SOLO,
      trainers: [
        { itemId: '9', naam: 'Sam Speler', telefoon: '', isActeur: true, isCoTrainer: false },
      ],
    };

    const uit = buildTabView(alleenActeur, {
      checklist: { ...EMPTY_CHECKLIST, ownGroup: true },
      actorItemIds: [],
      actorAnswered: true,
    });

    // De acteurvraag blijft, de groepskeuze niet.
    expect(uit.soloTrainer).toBe(false);
    expect(uit.groepskeuzeNvt).toBe(true);
    expect(uit.checklist.ownGroup).toBe(false);
    expect(uit.checklist.sameGroup).toBe(false);
  });

  it('laat de groepskeuze staan zodra er twee mensen gekoppeld zijn', () => {
    const uit = buildTabView(TRAINING, {
      checklist: { ...EMPTY_CHECKLIST, ownGroup: true },
      actorItemIds: [],
      actorAnswered: true,
    });

    expect(uit.groepskeuzeNvt).toBe(false);
    expect(uit.checklist.ownGroup).toBe(true);
  });

  /**
   * Een acteur is geen tweede trainer, dus de groepsvraag hoort ook dan te verdwijnen.
   *
   * "Meerdere trainers op deze sessie" gaat over het verdelen van de groep tússen trainers.
   * Bij lead + acteur is er één trainer; de acteur krijgt geen eigen groep. Op het bord zijn
   * 3 van de 4 trainingen die de vraag zouden krijgen precies dit geval.
   */
  it('verbergt de groepskeuze bij lead plus acteur', () => {
    const metActeur: BriefingTraining = {
      ...SOLO,
      acteuraantal: 1,
      trainers: [
        { itemId: '1', naam: 'Frank Paats', telefoon: '', isActeur: false, isCoTrainer: false },
        { itemId: '9', naam: 'Sam Speler', telefoon: '', isActeur: true, isCoTrainer: false },
      ],
    };

    const uit = buildTabView(metActeur, {
      checklist: { ...EMPTY_CHECKLIST, trainingActor: true, ownGroup: true },
      actorItemIds: [],
      actorAnswered: true,
    });

    expect(uit.groepskeuzeNvt).toBe(true);
    expect(uit.checklist.ownGroup).toBe(false);
  });

  /** Lead + co-trainer is de enige vorm waarin de vraag écht iets betekent. */
  it('toont de groepskeuze bij lead plus co-trainer', () => {
    const uit = buildTabView(TRAINING, {
      checklist: { ...EMPTY_CHECKLIST, ownGroup: true },
      actorItemIds: [],
      actorAnswered: true,
    });

    expect(uit.groepskeuzeNvt).toBe(false);
    expect(uit.checklist.ownGroup).toBe(true);
  });

  it('laat een acteuraantal van 0 gewoon door', () => {
    expect(buildTabView({ ...SOLO, acteuraantal: 0 }, opgeslagen()).kanGenereren).toBe(true);
  });
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
