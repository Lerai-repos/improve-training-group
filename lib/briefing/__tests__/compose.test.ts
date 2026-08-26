import { describe, expect, it } from 'vitest';

import {
  EMPTY_CHECKLIST,
  prefillTrainingActor,
  recurringClientBlock,
  selectBlocks,
  type HistoryRow,
  type SessionFacts,
} from '../blocks';
import { composeBriefing, openIssues, sessionFacts } from '../compose';
import { briefingFilename, templatePath } from '../render';

import type { BriefingTraining } from '../types';

/** De live waarden van item 2620142638, de training van de voorbeeldbriefing. */
const PROBIBLIO: BriefingTraining = {
  itemId: '2620142638',
  naam: 'Probiblio',
  label: 'IT',
  brie: 'Verzonden',
  opdrachtgever: 'Probiblio',
  themas: ['Verbindend communiceren'],
  themaInhoud: '',
  klanttitel: 'Verbindend communiceren',
  duur: '3',
  datum: '2026-03-24',
  tijden: '09:30-12:30',
  groepsgrootte: '10-20',
  locatie: 'BrasserieBuitenhuis,J. Pellenbargweg 2, 2235 SP Valkenburg',
  voertaal: 'NL',
  klantcontactmoment: 'Telefoon',
  evaluatie: 'Geen QR (deze sessie)',
  ieCode: '',
  accountmanager: { naam: 'Dirkje Pril', mobiel: '+31648431025' },
  contactpersoon: { naam: 'Paula Hollander', telefoon: '+31642085076' },
  trainers: [
    {
      itemId: '1',
      naam: 'Lennart Bosschaart',
      telefoon: '0618683139',
      isActeur: false,
      isCoTrainer: false,
    },
  ],
  acteuraantal: null,
  opportunityItemId: '2674263314',
  achtergrond: 'Probiblio ondersteunt openbare bibliotheken.',
  missing: [],
};

describe('composeBriefing', () => {
  /**
   * Twaalf van de zestien rijen van ITG's eigen briefing, letterlijk. De vier die hier niet
   * staan zijn Klanttitel (op het bord inmiddels anders), Accountmanager (Monday kent alleen
   * de voornaam), Km./Reistijd en Trainingscode MC — die laatste twee zijn nog niet
   * aangesloten en horen dus een `«…»`-regel te geven.
   */
  it('reproduceert de gegevenstabel van de voorbeeldbriefing', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST);
    expect(data).toMatchObject({
      opdrachtgever: 'Probiblio',
      thema: 'Verbindend communiceren',
      duur: '3 uur',
      datumTijd: '24 maart 2026; 09:30 - 12:30 uur',
      groepsgrootte: '± 10-20 deelnemers',
      locatie: 'BrasserieBuitenhuis,J. Pellenbargweg 2, 2235 SP Valkenburg',
      voertaal: 'Nederlands',
      materialenDeadline: '19 maart 2026; 09:30 uur (bijv. PowerPoint)',
      accountmanager: 'Dirkje Pril / 06-48431025',
      contactpersoon: 'Paula Hollander (06-42085076)',
      klantcontactmoment: 'Telefonisch contact',
      evaluatie: 'Nee',
      iecode: 'Geen',
    });
  });

  it('voegt meerdere thema’s samen tot één regel', () => {
    const data = composeBriefing(
      { ...PROBIBLIO, themas: ['Feedback', 'Assertiviteit'] },
      EMPTY_CHECKLIST
    );
    expect(data.thema).toBe('Feedback & Assertiviteit');
  });

  /**
   * Het hele punt van de `«…»`-regels: een niet-aangesloten bron moet in het document
   * zichtbaar zijn. Een lege sectie ziet eruit als een afgeronde briefing.
   */
  it('markeert elke bron die nog niet is aangesloten', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST);
    expect(openIssues(data)).toHaveLength(6);
    expect(data.reis).toContain('km en reistijd');
  });

  /**
   * De achtergrondinformatie komt uit `itg_achtergrond` op de gekoppelde Opportunity, zonder
   * dat de aanroeper hem hoeft mee te geven. Zolang dat niet gebeurde, kreeg élke briefing
   * een `«…»`-regel op de plek van een tekst die de adviseur allang had getypt.
   */
  it('neemt de achtergrondtekst van de Opportunity over', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST);
    expect(data.achtergrond).toEqual(['Probiblio ondersteunt openbare bibliotheken.']);
  });

  /** Dirkje: *"We gebruiken wel altijd meerdere alinea's."* */
  it('splitst de achtergrondtekst in alinea’s', () => {
    const data = composeBriefing(
      { ...PROBIBLIO, achtergrond: 'Eerste alinea.\n\n  Tweede alinea.  \n' },
      EMPTY_CHECKLIST
    );
    expect(data.achtergrond).toEqual(['Eerste alinea.', 'Tweede alinea.']);
  });

  /**
   * Aangesloten en leeg, en tóch zichtbaar: de kolom bestaat, de adviseur heeft hem nog niet
   * ingevuld. Een weggelaten sectie ziet eruit als een afgeronde briefing.
   */
  it('houdt een lege achtergrondkolom zichtbaar in het document', () => {
    const data = composeBriefing({ ...PROBIBLIO, achtergrond: '   ' }, EMPTY_CHECKLIST);
    expect(data.achtergrond[0]).toContain('achtergrondinformatie');
    expect(openIssues(data)).toHaveLength(7);
  });

  /** De aanroeper mag hem nog steeds overschrijven — de kolom is de bron, niet de baas. */
  it('laat een meegegeven achtergrond voorgaan op de kolom', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST, { achtergrond: ['Eigen tekst.'] });
    expect(data.achtergrond).toEqual(['Eigen tekst.']);
  });

  /**
   * De historie is nog niet aangesloten, dus elke briefing die wij nu maken zou de sectie
   * `Vaste klant` stilzwijgend weglaten en er compleet uitzien. Een trainer bij een vaste
   * klant krijgt dan geen enkel signaal dat er meer sessies zijn.
   */
  it('laat zien dat de historie nog niet is aangesloten', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST);
    const vasteKlant = data.blokken.find((b) => b.titel === 'Vaste klant');
    expect(vasteKlant?.regels[0]?.tekst).toContain('nog niet aangesloten');
    expect(openIssues(data).some((p) => p.includes('sessies bij deze klant'))).toBe(true);
  });

  /**
   * `0. NOTK` betekent nog te kennen: de QR-keuze staat nog open. `Ja, gebruik de QR code`
   * is geen aanname maar een instructie, en de trainer gaat dan een code ophangen die niet
   * bestaat. 17 trainingen staan hierop.
   */
  it('maakt van een onbesliste QR-kolom geen stellig ja', () => {
    const data = composeBriefing({ ...PROBIBLIO, evaluatie: '0. NOTK' }, EMPTY_CHECKLIST);
    expect(data.evaluatie).not.toContain('Ja');
    expect(data.evaluatie).toContain('nog niet bepaald');
    expect(openIssues(data).some((p) => p.includes('evaluatie deelnemers'))).toBe(true);
  });

  /** Aangesloten en leeg is iets anders dan niet aangesloten. */
  it('zwijgt over een bron die is aangesloten en niets oplevert', () => {
    const data = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST, {
      achtergrond: ['Probiblio ondersteunt openbare bibliotheken.'],
      extraInfo: [],
      bullets: ['Plenaire opening.'],
      inventarisatie: [],
      historie: [],
      trainingscodeMc: 'IT-58',
      reis: { roundTripKm: 126, roundTripMinutes: 100, thresholdMinutes: 90 },
    });
    expect(openIssues(data)).toEqual([]);
    expect(data.extraInfo).toEqual([]);
    expect(data.reis).toBe('Totaal: 126 km. / Totaal: 100 min. (10 min. factureren)');
  });

  it('laat een lege accountmanager of contactpersoon leeg in plaats van halve haakjes', () => {
    const data = composeBriefing(
      { ...PROBIBLIO, accountmanager: null, contactpersoon: null },
      EMPTY_CHECKLIST
    );
    expect(data.accountmanager).toBe('');
    expect(data.contactpersoon).toBe('');
  });

  /** Acceptatiecriterium 3: zonder de voorbereidende opdracht verdwijnt die alinea. */
  it('zet de voorbereidende opdracht alleen erin als de checklist dat zegt', () => {
    const omitted = composeBriefing(PROBIBLIO, EMPTY_CHECKLIST);
    const included = composeBriefing(PROBIBLIO, {
      ...EMPTY_CHECKLIST,
      preparatoryAssignment: true,
    });
    expect(omitted.blokken.map((b) => b.titel)).not.toContain('Voorbereidende opdracht');
    expect(included.blokken.map((b) => b.titel)).toContain('Voorbereidende opdracht');
  });
});

/** Eén trainer, geen acteur: het geval waarin geen enkel rolblok verplicht is. */
const SOLO: SessionFacts = { certainTrainers: 1, identifiedActors: 0, unknownRole: 0 };

describe('selectBlocks', () => {
  const HISTORY: HistoryRow[] = [
    {
      datum: '12-01-2026',
      tijd: '09:30 - 12:30',
      klanttitel: 'Speeddaten',
      trainer: 'Tessa de Haas (06-24118840)',
      contactpersoon: 'Paula Hollander',
    },
  ];

  it('houdt de volgorde van het bronbestand aan', () => {
    const blocks = selectBlocks(
      {
        ...EMPTY_CHECKLIST,
        sameGroup: true,
        trainingCycle: true,
        homework: true,
        preparatoryAssignment: true,
      },
      HISTORY,
      SOLO
    );
    expect(blocks.map((b) => b.titel)).toEqual([
      'Lead- en co-trainer(s) op dezelfde groep',
      'Vaste klant',
      'Trainings/workshop/teambuilding cyclus',
      'Huiswerkopdracht',
      'Voorbereidende opdracht',
    ]);
  });

  /**
   * Dit zijn de twee antwoorden op één vraag. Zelf kiezen zou de briefing stellig het
   * verkeerde laten beweren over hoe de groep wordt opgesplitst.
   */
  it('weigert beide groepsvarianten tegelijk', () => {
    expect(() =>
      selectBlocks({ ...EMPTY_CHECKLIST, ownGroup: true, sameGroup: true }, [], SOLO)
    ).toThrow(/niet allebei/);
  });

  it('laat het blok Vaste klant weg zonder eerdere sessies', () => {
    expect(recurringClientBlock([])).toBeNull();
    expect(selectBlocks(EMPTY_CHECKLIST, [], SOLO)).toEqual([]);
  });

  /** Niet aangesloten en leeg zijn twee verschillende antwoorden, en zien er anders uit. */
  it('houdt "nog geen historie-bron" en "geen eerdere sessies" uit elkaar', () => {
    const withoutSource = recurringClientBlock(undefined);
    expect(withoutSource?.titel).toBe('Vaste klant');
    expect(withoutSource?.regels[0]?.tekst).toContain('nog niet aangesloten');
    expect(recurringClientBlock([])).toBeNull();
  });

  /**
   * Acceptatiecriteria 2 en 3, letterlijk: dezelfde cyclusbriefing mét en zónder de
   * voorbereidende opdracht, waarbij alleen de geneste alinea verdwijnt. Een cyclus zonder
   * voorbereidende opdracht is dus een gevraagde toestand en geen fout.
   */
  it('laat de geneste cyclusalinea meebewegen met de voorbereidende opdracht', () => {
    const NESTED =
      'Vóór de eerste sessie ontvangen deelnemers een voorbereidende reflectieopdracht.';

    const zonder = selectBlocks(
      { ...EMPTY_CHECKLIST, trainingCycle: true, homework: true },
      [],
      SOLO
    );
    const cyclusZonder = zonder.find((b) => b.titel.includes('cyclus'));
    expect(cyclusZonder).toBeDefined();
    expect(cyclusZonder?.regels.some((r) => r.tekst.startsWith(NESTED))).toBe(false);

    const met = selectBlocks(
      { ...EMPTY_CHECKLIST, trainingCycle: true, homework: true, preparatoryAssignment: true },
      [],
      SOLO
    );
    const cyclusMet = met.find((b) => b.titel.includes('cyclus'));
    expect(cyclusMet?.regels.some((r) => r.tekst.startsWith(NESTED))).toBe(true);

    // Alleen die ene alinea verschilt; de rest van het blok is identiek.
    expect(cyclusMet?.regels.filter((r) => !r.tekst.startsWith(NESTED))).toEqual(
      cyclusZonder?.regels
    );
  });

  /** `06-briefing.md`: het cyclusblok is de uitleg **plus het cyclusschema als afbeelding**. */
  it('hangt het cyclusschema aan het cyclusblok', () => {
    const blocks = selectBlocks({ ...EMPTY_CHECKLIST, trainingCycle: true }, [], SOLO);
    expect(blocks.find((b) => b.titel.includes('cyclus'))?.afbeelding).toBe('cyclusschema.png');
    // Geen ander blok brengt een afbeelding mee.
    expect(blocks.filter((b) => b.afbeelding !== undefined)).toHaveLength(1);
  });

  /**
   * De geneste alinea verwijst naar het kopje `Huiswerkopdracht`. Dat vinkje is volgens de
   * specificatie apart, dus dit mag voorkomen — maar de trainer gaat anders zoeken naar
   * instructies die er niet staan.
   */
  it('markeert een verwijzing naar een kopje dat niet is aangevinkt', () => {
    const blocks = selectBlocks(
      { ...EMPTY_CHECKLIST, trainingCycle: true, preparatoryAssignment: true },
      [],
      SOLO
    );
    const cyclus = blocks.find((b) => b.titel.includes('cyclus'));
    expect(
      cyclus?.regels.some(
        (r) => r.tekst.includes('Huiswerkopdracht') && r.tekst.includes('nog niet bepaald')
      )
    ).toBe(true);
  });

  /**
   * Bij meerdere trainers of een acteur hóórt er een blok, maar welke variant hangt af van
   * een rol die Monday niet vastlegt. Weglaten zonder spoor zou een co-trainer een briefing
   * geven waarin nergens staat dat er een lead is.
   */
  it('maakt de nog niet gebouwde rolblokken zichtbaar', () => {
    const twee = selectBlocks(EMPTY_CHECKLIST, [], {
      certainTrainers: 2,
      identifiedActors: 0,
      unknownRole: 0,
    });
    expect(twee.map((b) => b.titel)).toContain('Leadtrainer / Co-trainer');
    expect(twee[0]?.regels[0]?.tekst).toContain('nog niet aangesloten');

    const acteur = selectBlocks({ ...EMPTY_CHECKLIST, trainingActor: true }, [], SOLO);
    expect(acteur.map((b) => b.titel)).toContain('Trainingsacteur');
  });

  /**
   * De trainerrelatie mengt trainers en acteurs: `Acteuraantal=1` met twee gekoppelde
   * personen, waarvan er één in de groep `Acteurs` zit, komt 20 keer voor. Zou de acteur
   * meetellen als trainer, dan kreeg de trainer een blok over een co-trainer die er niet is.
   */
  it('telt een herkende acteur niet mee als co-trainer', () => {
    const blocks = selectBlocks({ ...EMPTY_CHECKLIST, trainingActor: true }, [], {
      certainTrainers: 1,
      identifiedActors: 1,
      unknownRole: 0,
    });
    expect(blocks.map((b) => b.titel)).toEqual(['Trainingsacteur']);
  });

  /**
   * Het gemeten randgeval: `Acteuraantal=1`, twee gekoppelde personen, en geen van beiden
   * staat in de groep `Acteurs` — 8 keer op het bord. Er is dus één acteur, maar wie het is
   * staat nergens. Beweren dat er een co-trainer is, is dan net zo fout als het weglaten.
   */
  it('beweert niets als de rol van een gekoppelde persoon onbekend is', () => {
    const blocks = selectBlocks({ ...EMPTY_CHECKLIST, trainingActor: true }, [], {
      certainTrainers: 1,
      identifiedActors: 0,
      unknownRole: 1,
    });
    expect(blocks.map((b) => b.titel)).toEqual(['Rolverdeling onduidelijk', 'Trainingsacteur']);
    expect(blocks.map((b) => b.titel)).not.toContain('Leadtrainer / Co-trainer');
    expect(blocks[0]?.regels[0]?.tekst).toContain('nog niet bepaald');
  });

  /**
   * `Acteuraantal` is leeg op 264 van de 815 trainingen, dus leeg betekent onbekend en niet
   * nul. De checklist beslist; die kolom mag alleen voorinvullen.
   */
  it('laat de checklist beslissen over de acteur, niet Monday', () => {
    expect(
      selectBlocks(EMPTY_CHECKLIST, [], { certainTrainers: 1, identifiedActors: 1, unknownRole: 0 })
    ).toEqual([]);
    expect(
      selectBlocks({ ...EMPTY_CHECKLIST, trainingActor: true }, [], SOLO).map((b) => b.titel)
    ).toEqual(['Trainingsacteur']);
  });

  /** De voorinvulling gebruikt twee onvolledige signalen, want elk apart mist gevallen. */
  it('stelt de acteurvraag voor uit beide aanwijzingen', () => {
    expect(prefillTrainingActor(1, 0)).toBe(true); // 8 keer gemeten: aantal ingevuld, geen groep
    expect(prefillTrainingActor(null, 1)).toBe(true); // 5 keer gemeten: groep wel, aantal leeg
    expect(prefillTrainingActor(0, 0)).toBe(false);
    expect(prefillTrainingActor(null, 0)).toBe(false);
  });
});

describe('sessionFacts', () => {
  const trainer = (id: string, isActeur: boolean, isCoTrainer = false) => ({
    itemId: id,
    naam: id,
    telefoon: '',
    isActeur,
    isCoTrainer,
  });

  it('scheidt de herkende acteurs van de trainers', () => {
    const facts = sessionFacts(
      { ...PROBIBLIO, acteuraantal: 1, trainers: [trainer('a', false), trainer('b', true)] },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(facts).toEqual({ certainTrainers: 1, identifiedActors: 1, unknownRole: 0 });
  });

  /**
   * Het gemeten randgeval, nu vanaf de gegevenskant: één acteur volgens de kolom, twee
   * gekoppelde personen, geen van beiden in de groep. Precies één van die twee is trainer,
   * en welke weten we niet.
   */
  it('houdt een onherkende acteur als onbekende rol apart', () => {
    const facts = sessionFacts(
      { ...PROBIBLIO, acteuraantal: 1, trainers: [trainer('a', false), trainer('b', false)] },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(facts).toEqual({ certainTrainers: 1, identifiedActors: 0, unknownRole: 1 });
  });

  /** Zegt de adviseur dat er geen acteur is, dan is er niets onbekends. */
  it('kent geen onbekende rollen als er geen acteur is', () => {
    const facts = sessionFacts(
      { ...PROBIBLIO, acteuraantal: 1, trainers: [trainer('a', false), trainer('b', false)] },
      EMPTY_CHECKLIST
    );
    expect(facts).toEqual({ certainTrainers: 2, identifiedActors: 0, unknownRole: 0 });
  });

  /** Een leeg `Acteuraantal` met een bevestigde acteur betekent er minstens één. */
  it('gaat bij een leeg Acteuraantal uit van één acteur', () => {
    const facts = sessionFacts(
      { ...PROBIBLIO, acteuraantal: null, trainers: [trainer('a', false), trainer('b', false)] },
      { ...EMPTY_CHECKLIST, trainingActor: true }
    );
    expect(facts).toEqual({ certainTrainers: 1, identifiedActors: 0, unknownRole: 1 });
  });
});

describe('briefingFilename', () => {
  it('schrijft de naam zoals ITG hem zelf schrijft', () => {
    expect(
      briefingFilename({
        opdrachtgever: 'Probiblio',
        thema: 'Verbindend communiceren',
        isoDatum: '2026-03-24',
        trainers: ['Lennart Bosschaart'],
      })
    ).toBe('Briefing Probiblio - Verbindend communiceren - 24-03-2026 - Lennart Bosschaart.docx');
  });

  /**
   * Acceptatiecriterium 9. De schuine streep kan in elk onderdeel zitten, niet alleen in de
   * klantnaam — een thema als `Feedback geven/ontvangen` doet hetzelfde.
   */
  it('saneert een schuine streep waar hij ook staat', () => {
    const name = briefingFilename({
      opdrachtgever: 'Gemeente Ede / Wageningen',
      thema: 'Feedback geven/ontvangen',
      isoDatum: '2026-03-24',
      trainers: ['Jan Jansen'],
    });
    expect(name).not.toContain('/');
    expect(name).toBe(
      'Briefing Gemeente Ede - Wageningen - Feedback geven-ontvangen - 24-03-2026 - Jan Jansen.docx'
    );
  });

  it('laat lege onderdelen weg in plaats van dubbele streepjes', () => {
    expect(
      briefingFilename({ opdrachtgever: 'Probiblio', thema: '', isoDatum: '', trainers: [] })
    ).toBe('Briefing Probiblio.docx');
  });
});

describe('templatePath', () => {
  it('wijst elk label naar zijn eigen sjabloon', () => {
    expect(templatePath('IT')).toMatch(/IT\.docx$/);
    expect(templatePath('sst')).toMatch(/SST\.docx$/);
  });

  /** Terugvallen op een standaardsjabloon zou het logo van een ander merk opleveren. */
  it('weigert een onbekend label in plaats van terug te vallen', () => {
    expect(() => templatePath('')).toThrow(/onbekend label/);
    expect(() => templatePath('../../etc/passwd')).toThrow(/onbekend label/);
  });
});
