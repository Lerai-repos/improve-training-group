import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { composeBriefing } from '../compose';
import { resolveRecipientRoles } from '../recipients';
import { leesLogo } from '../logo';
import { heeftEigenSjabloon, renderBriefing, TEMPLATES_DIR } from '../render';
import { zipReadText } from './zip-reader';

import { SECTIES } from '@lib/briefingteksten/catalog';
import { tekstenUit } from '@lib/briefingteksten/teksten';

import type { TekstRij } from '@lib/briefingteksten/beoordeel';
import type { BriefingTeksten, TekstSleutel } from '@lib/briefingteksten/types';
import type { BriefingChecklist, HistoryRow } from '../blocks';
import type { BriefingTraining } from '../types';

/**
 * De opbouw van de negen sjablonen zelf, en van wat er uit komt.
 *
 * `render.test.ts` rendert alléén `IT`. Dat is genoeg om te controleren of de commando's
 * werken, maar niet of de negen sjablonen dezelfde opbouw hebben — en die opbouw is precies
 * wat op 24-Aug-2026 verbouwd is: de gegevenstabel uit het tekstvak, de gele markering eruit,
 * echte opsommingstekens, en de rolblokken onder `Concept inhoud`.
 *
 * Elk van die vier faalt **stil**. Een sjabloon dat opnieuw gegenereerd wordt met een oudere
 * `convert.py` levert een document op dat prima opent, waarin Word de tabel gewoon toont, en
 * waarin alleen Google Docs de hele tabel weglaat. Geen enkele bestaande test merkt dat.
 *
 * Daarom staan de controles hier op de XML en niet op de tekst: de tekst is in beide gevallen
 * identiek. Zie het geheugen `itg-briefing-sjabloonopbouw` voor het waarom van elke keuze.
 */

const LABELS = ['CC', 'CP', 'FT', 'FV', 'IT', 'JE', 'SST', 'TT', 'WJ'] as const;

/**
 * Wat er gerenderd wordt: de acht eigen sjablonen, en het algemene via een label dat er geen
 * heeft (`ITG`). FT niet meer: dat heet sinds 21-Oct-2026 "Feedback Trainer" en valt op het
 * algemene sjabloon, dus `FT.docx` wordt door geen label meer gebruikt.
 */
const GERENDERD = ['CC', 'CP', 'FV', 'IT', 'JE', 'SST', 'TT', 'WJ', 'ITG'] as const;

/** Een doorzichtige PNG van 1x1 pixel: genoeg voor het algemene sjabloon. */
const TESTLOGO = leesLogo(
  Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    ),
    (c) => c.charCodeAt(0)
  ),
  'test.png'
);

/** Het logo alleen voor een label zonder eigen sjabloon, zoals de echte keten het doet. */
const opties = (label: string) => (heeftEigenSjabloon(label) ? {} : { logo: TESTLOGO });

/** Het eerste veld van de gegevenstabel; waar dit staat, staat de tabel. */
const TABLE_MARKER = '+++opdrachtgever+++';
/** De alinea die per concept-regel herhaald wordt. */
const CONCEPT_LINE = '+++$b+++';
/** De alinea die per blokregel herhaald wordt, in de opsommingsvariant. */
const BLOCK_LINE = '+++$r.tekst+++';
/** De titel van een blok, in beide lussen dezelfde tekst. */
const BLOCK_TITLE = '+++$blk.titel+++';
/**
 * ITG's aansporing over de Monday Challenges — op het STAARTJE, niet op de hele zin.
 *
 * Sinds 30-Sep-2026 staat die zin op het bord Briefingteksten en niet meer in het sjabloon;
 * de tests controleren dat hij daar wég is en in het gerenderde document wél staat.
 */
const MC_BANNER = 'aan te bieden';

/**
 * Een markering opzoeken op kleur.
 *
 * Als patroon en niet als letterlijke tekst: `convert.py` serialiseert opnieuw met
 * ElementTree en dat schrijft `<w:highlight w:val="cyan" />` mét spatie, terwijl Word zelf
 * `<w:highlight w:val="cyan"/>` schrijft. Op de letterlijke vorm zoeken laat een
 * `not.toContain` altijd slagen — de test keurt dan niets meer.
 */
const highlight = (kleur: string): RegExp => new RegExp(`<w:highlight[^>]*w:val="${kleur}"`);

function templateXml(label: string): string {
  return zipReadText(readFileSync(path.join(TEMPLATES_DIR, `${label}.docx`)), 'word/document.xml');
}

/** De begin- en eindposities van elk tekstvak in het document. */
function boxRanges(xml: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const open = '<w:txbxContent>';
  const close = '</w:txbxContent>';
  let at = xml.indexOf(open);
  while (at !== -1) {
    const end = xml.indexOf(close, at);
    if (end === -1) {
      throw new Error('sjabloon: een <w:txbxContent> is niet afgesloten');
    }
    ranges.push([at, end + close.length]);
    at = xml.indexOf(open, end);
  }
  return ranges;
}

function insideBox(xml: string, at: number): boolean {
  return boxRanges(xml).some(([from, to]) => at >= from && at <= to);
}

/**
 * De alinea waar `at` in valt.
 *
 * `lastIndexOf('<w:p')` zou ook `<w:pPr>` en `<w:pStyle>` raken, dus we zoeken op de twee
 * vormen die een alinea écht opent.
 */
function paragraphAt(xml: string, at: number): string {
  const starts = [xml.lastIndexOf('<w:p>', at), xml.lastIndexOf('<w:p ', at)];
  const start = Math.max(...starts);
  const end = xml.indexOf('</w:p>', at);
  if (start === -1 || end === -1) {
    throw new Error('sjabloon: geen omsluitende alinea gevonden');
  }
  return xml.slice(start, end);
}

function positionOf(xml: string, needle: string): number {
  const at = xml.indexOf(needle);
  expect(at, `${needle} komt niet voor in het sjabloon`).toBeGreaterThan(-1);
  return at;
}

describe.each(LABELS)('sjabloon %s', (label) => {
  /**
   * De reden dat de tabel überhaupt uit het tekstvak is getild: Google Docs laat tekstvakken
   * bij het importeren volledig weg, en daar verdween dus de héle gegevenstabel. In Word valt
   * het niet op, dus alleen deze controle bewaakt het.
   */
  it('heeft de gegevenstabel buiten een tekstvak staan', () => {
    const xml = templateXml(label);
    expect(insideBox(xml, positionOf(xml, TABLE_MARKER))).toBe(false);
  });

  /** De tabel staat één keer in het document; de mc:Fallback-kopie is bij het optillen weg. */
  it('heeft de gegevenstabel precies één keer', () => {
    const xml = templateXml(label);
    expect(xml.split(TABLE_MARKER).length - 1).toBe(1);
  });

  /**
   * ITG's gele markering betekent "hier moet nog iets in". Wij vullen die velden
   * automatisch, dus zou de markering op afgeronde tekst blijven staan — de hele briefing
   * komt dan geel uit de generator. In ITG's eigen verstuurde briefing staat op geen enkele
   * letter nog een markering.
   */
  it('heeft geen gele markering meer', () => {
    expect(templateXml(label)).not.toMatch(highlight('yellow'));
  });

  /**
   * Precies ÉÉN aansporing over de Monday Challenges, plus de kolom in de tabel.
   *
   * Er stonden er even drie: de cyaan regel die met het tekstvak wordt opgetild, de
   * `Trainingscode MC`-rij in de tabel, én een derde die `body.py` onder de
   * achtergrondinformatie zette. Tim, 28-Aug-2026: *"the cyan one and the one in the table
   * are correct"*.
   *
   * Sinds 30-Sep-2026 staat de tekst van de cyaan regel op het bord Briefingteksten; het
   * sjabloon heeft er één lus voor, en de zin zelf staat er niet meer in.
   */
  it('heeft één losse Monday Challenges-regel, naast de tabelrij', () => {
    const xml = templateXml(label);

    expect(xml.split('+++FOR m IN mondayChallenges+++').length - 1).toBe(1);
    expect(xml).not.toContain(MC_BANNER);
    expect(xml).toContain('+++trainingscodeMc+++');
  });

  /**
   * De regel is ONVOORWAARDELIJK, en dat is een keuze.
   *
   * Hij staat op elke briefing, ook zonder Monday Challenge. De conditionele variant is
   * vervallen samen met het vinkje; weg is hij alleen als ITG de tekst op het bord leegmaakt.
   */
  it('zet de Monday Challenges-regel niet achter een IF', () => {
    expect(templateXml(label)).not.toMatch(/\+\+\+IF[^+]*mondayChallenge/);
  });

  /** De cyaan markering zit op de lusregel zelf, anders is ITG's tekst gewone tekst. */
  it('geeft de Monday Challenges-regel de cyaan markering', () => {
    const xml = templateXml(label);
    expect(paragraphAt(xml, positionOf(xml, '+++$m+++'))).toMatch(highlight('cyan'));
  });

  /**
   * Geen enkele vaste tekst meer in het sjabloon: elke zin komt van het bord.
   *
   * Stond er nog een, dan zou ITG hem op het bord aanpassen en hem in het document
   * ongewijzigd terugzien — of twee keer, de oude en de nieuwe.
   */
  it('bevat geen van de teksten die nu op het bord staan', () => {
    const xml = templateXml(label);
    for (const zin of [
      'Binnenkort organiseer je namens',
      'Behoefte aan vervolg',
      'Vragen? We horen het graag!',
      'Het volgende concept programma',
      'Onderstaande informatie komt uit',
      'Het inventarisatieformulier is (nog) niet ingevuld',
    ]) {
      expect(xml, zin).not.toContain(zin);
    }
  });

  /**
   * De ruimte onder de kopband `Algemeen.` hoort bij het sjabloon, niet bij de inleiding.
   *
   * Stond hij op de eerste alinea van de algemene tekst, dan schoof de rest omhoog onder de
   * kopband zodra ITG die inleiding leegmaakt.
   */
  it('houdt de ruimte onder Algemeen. vast, vóór de lus', () => {
    const xml = templateXml(label);
    const lus = positionOf(xml, '+++FOR s IN algemeen+++');
    const ruimte = xml.lastIndexOf('w:before="1077"', lus);
    expect(ruimte).toBeGreaterThan(-1);
    expect(lus - ruimte).toBeLessThan(400);
    expect(lus).toBeLessThan(positionOf(xml, TABLE_MARKER));
  });

  /** Een lege kop mag: dan hoort er geen lege kopregel te blijven staan. */
  it('zet elke kop die ITG kan leegmaken achter een IF', () => {
    const xml = templateXml(label);
    expect(xml.split('+++IF $blk.titel+++').length - 1).toBe(2);
    expect(xml.split('+++IF $s.kop+++').length - 1).toBe(4);
  });

  /**
   * Beide bloklussen geven hun titel dezelfde kop.
   *
   * De rolblokken erfden `Kop1` van de alinea `Concept inhoud`, de gewone blokken niet —
   * dus `Leadtrainer` was een kop en `Vaste klant`, `Huiswerkopdracht` en `Voorbereidende
   * opdracht` gewone tekst, in hetzelfde document. Zichtbaar zodra je het opent, en door
   * geen enkele test gedekt: de tekst was immers hetzelfde.
   */
  it('geeft de titel van élk blok en elke sectie de kopstijl', () => {
    const xml = templateXml(label);
    const posities = [BLOCK_TITLE, '+++$s.kop+++'].flatMap((needle) => {
      const gevonden: number[] = [];
      let at = xml.indexOf(needle);
      while (at !== -1) {
        gevonden.push(at);
        at = xml.indexOf(needle, at + needle.length);
      }
      return gevonden;
    });
    expect(posities).toHaveLength(6);

    for (const at of posities) {
      // Met of zonder spatie vóór de sluitende schuine streep; beide zijn geldige XML.
      expect(paragraphAt(xml, at)).toMatch(/<w:pStyle[^>]*w:val="Kop1"/);
    }
  });

  /** Cyaan blijft juist wél staan: dat is de opmerking over de Monday Challenges. */
  it('houdt de cyaan markering', () => {
    expect(templateXml(label)).toMatch(highlight('cyan'));
  });

  it('geeft de concept-regel een echt opsommingsteken', () => {
    const xml = templateXml(label);
    expect(paragraphAt(xml, positionOf(xml, CONCEPT_LINE))).toContain('<w:numPr>');
  });

  /**
   * DRIE varianten van dezelfde regel, want `docx-templates` kan tekst weglaten maar geen
   * alinea-opmaak omzetten — en het inspringniveau zit in de opmaak.
   *
   * Twee ervan zijn opsommingen (niveau 0 en 1), één is een gewone alinea. Ontbreekt de
   * diepe variant, dan komen de taken van de trainer op één lijn met hun kop te staan;
   * zijn er drie bullets, dan wordt élke blokregel een opsomming.
   */
  it('rendert blokregels in drie varianten: twee niveaus en een gewone alinea', () => {
    const xml = templateXml(label);
    const posities: number[] = [];
    let at = xml.indexOf(BLOCK_LINE);
    while (at !== -1) {
      posities.push(at);
      at = xml.indexOf(BLOCK_LINE, at + BLOCK_LINE.length);
    }
    // De drie varianten staan in zes lussen: rolblokken, overige blokken, en de vier
    // sectielussen voor de teksten van het bord (algemeen, concept, inventarisatie ×2).
    expect(posities).toHaveLength(18);

    const niveaus = posities.map((pos) => {
      const alinea = paragraphAt(xml, pos);
      const match = /<w:ilvl w:val="(\d)"/.exec(alinea);
      return alinea.includes('<w:numPr>') ? (match?.[1] ?? '?') : 'geen';
    });
    const telling = (waarde: string): number => niveaus.filter((n) => n === waarde).length;
    expect([telling('0'), telling('1'), telling('geen')]).toEqual([6, 6, 6]);
  });

  /**
   * Dirkje, 12-Oct-2026: eerst het concept programma, dan de teksten voor de rol, en daarna de
   * groep, vaste klant, cyclus en opdrachten. Dat draait Tims keuze van 24-Aug-2026 om.
   */
  it('zet Concept inhoud bovenaan, dan de rolblokken, dan de rest', () => {
    const xml = templateXml(label);
    const kop = positionOf(xml, '+++FOR s IN concept+++');
    const bullets = positionOf(xml, '+++FOR b IN bullets+++');
    const rol = positionOf(xml, '+++FOR blk IN rolblokken+++');
    const rest = positionOf(xml, '+++FOR blk IN blokken+++');
    expect(kop).toBeLessThan(bullets);
    expect(bullets).toBeLessThan(rol);
    expect(rol).toBeLessThan(rest);
  });
});

/**
 * Alle negen vullen dezelfde velden. Wijkt er één af, dan mist dat label stilletjes een
 * gegeven in elke briefing van dat merk — en alleen briefings van dat ene merk.
 */
it('vult in elk sjabloon dezelfde velden', () => {
  const velden = (label: string): string[] =>
    [...templateXml(label).matchAll(/\+\+\+([^+]{1,40}?)\+\+\+/g)].map((m) => m[1] ?? '').sort();
  const eerste = new Set(velden('IT'));
  for (const label of LABELS) {
    expect(new Set(velden(label)), `${label} wijkt af van IT`).toEqual(eerste);
  }
});

const TRAINING: BriefingTraining = {
  itemId: '1',
  naam: 'Probiblio',
  label: 'IT',
  brie: 'Aanmaken',
  opdrachtgever: 'Probiblio',
  trainingscodeMc: '',
  themas: ['Verbindend communiceren'],
  themaInhoud: 'Plenaire opening.\nOefenen met de praktijk.',
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
    {
      itemId: '2',
      naam: 'Tessa de Haas',
      telefoon: '0624118840',
      isActeur: false,
      isCoTrainer: true,
    },
  ],
  acteuraantal: null,
  opportunityItemId: null,
  achtergrond: 'Probiblio ondersteunt openbare bibliotheken.',
  conceptProgramma: '',
  extraInfo: '',
  aandacht: null,
  inventarisatie: { kind: 'niet-gelezen' },
  opdrachten: { trainingCycle: false, homework: false, preparatoryAssignment: false },
  cyclus: null,
  cyclusKeuze: null,
  cyclusVariant: '',
  missing: [],
};

/**
 * Hoeveel lege alinea's er direct vóór een kop staan.
 *
 * Dit is de enige bewaking op de witruimte tussen secties. Die kwam uit twee bronnen — de
 * vaste alinea's van het brondocument én een witregel per blok uit de lus — en telde dus op:
 * zonder rolblokken stonden er drie witregels vóór `Concept inhoud`, met rolblokken één, en
 * vóór `Inventarisatie klant` drie. Elke sectie brengt nu zijn eigen witregel mee, vóór zijn
 * titel. Een sjabloon dat opnieuw gegenereerd wordt met een oudere `body.py` opent prima en
 * leest hetzelfde; alleen de afstand klopt niet meer.
 */
function blanksBefore(xml: string, kop: string): number {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  const tekst = (p: string): string =>
    (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
      .map((t) => t.replace(/<[^>]+>/g, ''))
      .join('')
      .trim();
  const at = paragraphs.findIndex((p) => tekst(p) === kop);
  if (at === -1) {
    throw new Error(`kop "${kop}" niet gevonden in het gerenderde document`);
  }
  let n = 0;
  while (at - 1 - n >= 0 && tekst(paragraphs[at - 1 - n]) === '') {
    n += 1;
  }
  return n;
}

/**
 * Het document van de LEAD bij een sessie mét acteur.
 *
 * Dat is waar het blok `Werken met een trainingsacteur` in staat, en dus waar de twee
 * opsommingsniveaus te zien zijn. De co-trainer uit de fixture wordt hier de acteur.
 */
async function renderActor(label: string): Promise<string> {
  const training: BriefingTraining = {
    ...TRAINING,
    label,
    acteuraantal: 1,
    trainers: TRAINING.trainers.map((t) =>
      t.isCoTrainer ? { ...t, isActeur: true, isCoTrainer: false } : t
    ),
  };
  const checklist: BriefingChecklist = { ...EMPTY_CHECKLIST, trainingActor: true };
  const rollen = resolveRecipientRoles(training, checklist);
  if (rollen.kind !== 'resolved') {
    throw new Error(`fixture levert geen ontvangers op: ${rollen.kind}`);
  }
  const lead = rollen.recipients.find((r) => r.role === 'lead');
  if (lead === undefined) {
    throw new Error('fixture levert geen leadtrainer op');
  }
  const bytes = await renderBriefing(
    label,
    composeBriefing(training, checklist, { historie: [], recipient: lead }),
    opties(label)
  );
  return zipReadText(bytes, 'word/document.xml');
}

async function renderLead(label: string): Promise<string> {
  const training = { ...TRAINING, label };
  const rollen = resolveRecipientRoles(training, EMPTY_CHECKLIST);
  if (rollen.kind !== 'resolved') {
    throw new Error(`fixture levert geen ontvangers op: ${rollen.kind}`);
  }
  const lead = rollen.recipients.find((r) => r.role === 'lead');
  if (lead === undefined) {
    throw new Error('fixture levert geen leadtrainer op');
  }
  const bytes = await renderBriefing(
    label,
    composeBriefing(training, EMPTY_CHECKLIST, { historie: [], recipient: lead }),
    opties(label)
  );
  return zipReadText(bytes, 'word/document.xml');
}

/**
 * Dezelfde vier eigenschappen, maar dan in het document dat een trainer opent. Het sjabloon
 * kan kloppen terwijl het renderen ze alsnog kwijtraakt — zo verdween "Jij bent de
 * leadtrainer en dus verantwoordelijk voor:" toen `docx-templates` de `<w:br/>` binnen de
 * `<w:t>` zette.
 */
describe.each(GERENDERD)('gerenderde briefing %s', (label) => {
  it('houdt de gegevenstabel buiten een tekstvak', async () => {
    const xml = await renderLead(label);
    expect(insideBox(xml, positionOf(xml, 'Opdrachtgever'))).toBe(false);
  });

  it('heeft geen gele markering', async () => {
    expect(await renderLead(label)).not.toMatch(highlight('yellow'));
  });

  /** De vaste kopjes van de achtergrond vet, de tekst eronder niet; zie `isAchtergrondKop`. */
  it('zet de kopjes van de achtergrond vet', async () => {
    const training = {
      ...TRAINING,
      label,
      achtergrond: 'De aanleiding\nBinnen het team gaat het goed.',
    };
    const bytes = await renderBriefing(
      label,
      composeBriefing(training, EMPTY_CHECKLIST),
      opties(label)
    );
    const xml = await zipReadText(bytes, 'word/document.xml');

    expect(paragraphAt(xml, positionOf(xml, 'De aanleiding'))).toContain('<w:b/>');
    expect(paragraphAt(xml, positionOf(xml, 'Binnen het team gaat het goed.'))).not.toContain(
      '<w:b/>'
    );
    expect(xml).not.toContain('[object Object]');
  });

  /**
   * De drie titelsoorten uit het achtergronddocument elk op hun eigen grootte, en alle drie onder
   * de 14 pt van de sectiekoppen (`Kop1`), zodat ze niet als een nieuwe sectie lezen.
   */
  it('zet de kopjes uit het achtergronddocument op drie groottes', async () => {
    const training = {
      ...TRAINING,
      label,
      achtergrond: 'Groot kopje\nMiddel kopje\nKlein kopje\nGewone tekst.',
      achtergrondKoppen: [
        { tekst: 'Groot kopje', niveau: 1 as const },
        { tekst: 'Middel kopje', niveau: 2 as const },
        { tekst: 'Klein kopje', niveau: 3 as const },
      ],
      achtergrondUitDocument: true,
    };
    const bytes = await renderBriefing(
      label,
      composeBriefing(training, EMPTY_CHECKLIST),
      opties(label)
    );
    const xml = await zipReadText(bytes, 'word/document.xml');
    const alinea = (tekst: string) => paragraphAt(xml, positionOf(xml, tekst));

    expect(alinea('Groot kopje')).toContain('<w:b/>');
    expect(alinea('Groot kopje')).toContain('<w:sz w:val="27"/>');
    expect(alinea('Middel kopje')).toContain('<w:b/>');
    expect(alinea('Middel kopje')).toContain('<w:sz w:val="26"/>');
    expect(alinea('Klein kopje')).toContain('<w:b/>');
    expect(alinea('Klein kopje')).not.toContain('<w:sz ');
    expect(alinea('Gewone tekst.')).not.toContain('<w:b/>');
    // Elke alinea precies één keer: geen variant die naast een andere blijft staan.
    for (const tekst of ['Groot kopje', 'Middel kopje', 'Klein kopje', 'Gewone tekst.']) {
      expect(xml.split(tekst).length - 1).toBe(1);
    }
  });

  /** Zoals ITG's eigen voorbeeldbriefing: de vraag vet, het antwoord eronder, een witregel ertussen. */
  it('zet de vragen van de inventarisatie vet, met een witregel ervoor', async () => {
    const training = {
      ...TRAINING,
      label,
      inventarisatie: {
        kind: 'ingevuld' as const,
        op: '13-10-2026',
        antwoorden: [
          { vraag: 'Wat is je naam?', antwoord: 'Paula Hollander' },
          { vraag: 'Voor welke organisatie werk je?', antwoord: 'Probiblio' },
        ],
      },
    };
    const bytes = await renderBriefing(
      label,
      composeBriefing(training, EMPTY_CHECKLIST),
      opties(label)
    );
    const xml = await zipReadText(bytes, 'word/document.xml');

    expect(paragraphAt(xml, positionOf(xml, 'Wat is je naam?'))).toContain('<w:b/>');
    expect(paragraphAt(xml, positionOf(xml, 'Paula Hollander'))).not.toContain('<w:b/>');
    expect(blanksBefore(xml, 'Voor welke organisatie werk je?')).toBe(1);
  });

  it('geeft de concept-regels een opsommingsteken', async () => {
    const xml = await renderLead(label);
    expect(paragraphAt(xml, positionOf(xml, 'Plenaire opening.'))).toContain('<w:numPr>');
  });

  it('geeft de taken van de leadtrainer een opsommingsteken', async () => {
    const xml = await renderLead(label);
    expect(paragraphAt(xml, positionOf(xml, 'Ontwikkelen van training'))).toContain('<w:numPr>');
  });

  it('zet het rolblok onder Concept inhoud', async () => {
    const xml = await renderLead(label);
    expect(positionOf(xml, 'Concept inhoud')).toBeLessThan(positionOf(xml, 'Leadtrainer'));
    // Het blok brengt zijn eigen witregel mee, ook nu het na de bullets komt.
    expect(blanksBefore(xml, 'Leadtrainer')).toBe(1);
  });

  /**
   * `<w:br/>` hoort een broer van `<w:t>` te zijn, niet een kind. Stond het erbinnen, dan
   * werd de tekst erna een tail die uit het document verdween — zonder dat iets faalde.
   */
  /**
   * De acteurblokken hebben twee opsommingsniveaus, de rest niet.
   *
   * Het sjabloon heeft dáárvoor drie alinea-varianten in de bloklus, want `docx-templates`
   * kan tekst weglaten maar geen opmaak omzetten — en het inspringniveau zit in de opmaak.
   * Verdwijnt de derde variant, dan komen de taken van de trainer op één lijn met de kop
   * "De (lead) trainer is verantwoordelijk voor" te staan, en leest een acteur ze als
   * zijn eigen taken.
   */
  it('springt de taken in het acteurblok een niveau in', async () => {
    const xml = await renderActor(label);
    const kop = paragraphAt(xml, positionOf(xml, 'is verantwoordelijk voor'));
    const taak = paragraphAt(xml, positionOf(xml, 'Het tot leven brengen van de praktijk'));

    expect(kop).toMatch(/<w:ilvl w:val="0"/);
    expect(taak).toMatch(/<w:ilvl w:val="1"/);
  });

  /** De concept-regels blijven vlak; nesting daar zou van ITG's bron afwijken. */
  it('houdt de concept-regels op niveau 0', async () => {
    const xml = await renderLead(label);
    expect(paragraphAt(xml, positionOf(xml, 'Plenaire opening.'))).toMatch(/<w:ilvl w:val="0"/);
  });

  it('zet regelafbrekingen buiten w:t', async () => {
    const xml = await renderLead(label);
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*<w:br\/>/);
  });
});

/** Rendert het leaddocument met een eigen checklist en historie, voor de witruimtetest. */
async function renderMet(
  label: string,
  checklist: BriefingChecklist,
  historie: HistoryRow[],
  /**
   * Standaard de fixture mét co-trainer, want die levert een rolblok op.
   *
   * `alleenLead` schakelt naar één gekoppelde trainer, en dat is een ándere tak:
   * `recipientBlocks` voegt het lead-blok alleen toe als er ándere trainers zijn, dus dan
   * levert de rolblokkenlus **niets** op. Precies daar liet de oude opzet drie witregels
   * achter vóór `Concept inhoud` — en het is meteen het gewone geval: 221 van de 265
   * komende trainingen hebben één gekoppeld persoon.
   */
  alleenLead = false
): Promise<string> {
  const basis = { ...TRAINING, label };
  const training = alleenLead
    ? { ...basis, trainers: basis.trainers.filter((t) => !t.isCoTrainer) }
    : basis;
  const rollen = resolveRecipientRoles(training, checklist);
  if (rollen.kind !== 'resolved') {
    throw new Error(`fixture levert geen ontvangers op: ${rollen.kind}`);
  }
  const lead = rollen.recipients.find((r) => r.role === 'lead');
  if (lead === undefined) {
    throw new Error('fixture levert geen leadtrainer op');
  }
  const bytes = await renderBriefing(
    label,
    composeBriefing(training, checklist, { historie, recipient: lead }),
    opties(label)
  );
  return zipReadText(bytes, 'word/document.xml');
}

const HISTORIE_RIJ: HistoryRow = {
  datum: '12-01-2026',
  tijd: '09:30 - 12:30',
  klanttitel: 'Speeddaten',
  trainer: 'Tessa de Haas (06-24118840)',
  contactpersoon: 'Paula Hollander',
};

describe.each(GERENDERD)('witruimte tussen de secties, sjabloon %s', (label) => {
  /** Geen enkel inhoudelijk blok: alleen de vaste witregels blijven over. */
  it('houdt één witregel als er geen blokken zijn', async () => {
    const xml = await renderMet(label, EMPTY_CHECKLIST, []);

    expect(blanksBefore(xml, 'Concept inhoud')).toBe(1);
    expect(blanksBefore(xml, 'Inventarisatie klant')).toBe(1);
  });

  /**
   * Eén trainer, dus ook geen ROLBLOK — de tak waar het mis ging.
   *
   * Met een co-trainer levert de rolblokkenlus altijd een lead-blok op, en dan viel de fout
   * niet op: de witregel van dat blok verving toevallig de vaste witregels. Zonder rolblok
   * bleven ze alle drie staan.
   */
  it('houdt één witregel zonder enig rolblok', async () => {
    const xml = await renderMet(label, EMPTY_CHECKLIST, [], true);

    expect(xml).not.toContain('Leadtrainer');
    expect(blanksBefore(xml, 'Concept inhoud')).toBe(1);
    expect(blanksBefore(xml, 'Inventarisatie klant')).toBe(1);
  });

  /** Eén blok: de lus levert nu ook een witregel, en die mag niet optellen. */
  it('houdt één witregel met één blok', async () => {
    const xml = await renderMet(label, { ...EMPTY_CHECKLIST, homework: true }, []);

    expect(blanksBefore(xml, 'Concept inhoud')).toBe(1);
    expect(blanksBefore(xml, 'Huiswerkopdracht')).toBe(1);
    expect(blanksBefore(xml, 'Inventarisatie klant')).toBe(1);
  });

  /** Meerdere blokken, waaronder er een met een tabel eronder. */
  it('houdt één witregel tussen elk van meerdere blokken', async () => {
    const xml = await renderMet(
      label,
      { ...EMPTY_CHECKLIST, homework: true, preparatoryAssignment: true },
      [HISTORIE_RIJ]
    );

    for (const kop of [
      'Concept inhoud',
      'Vaste klant',
      'Huiswerkopdracht',
      'Voorbereidende opdracht',
      'Inventarisatie klant',
    ]) {
      expect({ kop, wit: blanksBefore(xml, kop) }).toEqual({ kop, wit: 1 });
    }
  });
});

/** Het bord zoals het er na `briefingteksten:create` uitziet, met één of meer items aangepast. */
function bordMet(
  wijzigingen: Partial<Record<TekstSleutel, { kop?: string; tekst?: string }>>
): BriefingTeksten {
  const rijen: TekstRij[] = SECTIES.map((s, i) => ({
    itemId: String(i),
    naam: s.naam,
    sleutel: s.sleutel,
    kop: wijzigingen[s.sleutel]?.kop ?? s.kop,
    tekst: wijzigingen[s.sleutel]?.tekst ?? s.tekst,
    status: '',
    melding: '',
  }));
  return tekstenUit(rijen, { merk: 'Incompany Trainer', term: 'Training' });
}

async function renderBord(teksten: BriefingTeksten, checklist = EMPTY_CHECKLIST): Promise<string> {
  const rollen = resolveRecipientRoles(TRAINING, checklist);
  if (rollen.kind !== 'resolved') {
    throw new Error(`fixture levert geen ontvangers op: ${rollen.kind}`);
  }
  const lead = rollen.recipients.find((r) => r.role === 'lead');
  if (lead === undefined) {
    throw new Error('fixture levert geen leadtrainer op');
  }
  const bytes = await renderBriefing(
    'IT',
    composeBriefing(TRAINING, checklist, { historie: [], recipient: lead, teksten })
  );
  return zipReadText(bytes, 'word/document.xml');
}

/** Alinea's met de kopstijl maar zonder tekst: een lege kopregel in het document. */
function legeKoppen(xml: string): number {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs.filter(
    (p) =>
      /w:val="Kop1"/.test(p) && !/<w:t[^>]*>[^<]*\S[^<]*<\/w:t>/.test(p) && !/<w:drawing/.test(p)
  ).length;
}

/**
 * Wat ITG op het bord kan doen, in het document dat een trainer opent.
 *
 * Tim, 30-Sep-2026: leeg is een keuze en dan verdwijnt de sectie; een fout wordt zichtbaar.
 */
describe('teksten van het bord Briefingteksten', () => {
  it('neemt een aangepaste tekst over, met opsommingen', async () => {
    const xml = await renderBord(
      bordMet({ 'algemeen.materialen': { tekst: 'Eigen zin.\n- Eerste punt\n-- Dieper punt' } })
    );
    expect(xml).toContain('Eigen zin.');
    expect(paragraphAt(xml, positionOf(xml, 'Eerste punt'))).toMatch(/<w:ilvl w:val="0"/);
    expect(paragraphAt(xml, positionOf(xml, 'Dieper punt'))).toMatch(/<w:ilvl w:val="1"/);
    expect(xml).not.toContain('professioneel en uniform');
  });

  it('vult {merk} en {term} in, ook in een kop', async () => {
    const xml = await renderBord(bordMet({}));
    expect(xml).toContain('Onder de vlag van Incompany Trainer');
    expect(xml).toContain('Inhoud training');
  });

  it('laat een leeggemaakte sectie met kop en al verdwijnen', async () => {
    const xml = await renderBord(
      bordMet({ 'algemeen.vervolg': { tekst: '' }, 'concept.inleiding': { tekst: '' } })
    );
    expect(xml).not.toContain('Behoefte aan vervolg');
    expect(xml).not.toContain('Concept inhoud');
    // De bullets van het thema blijven: die komen niet van dit bord.
    expect(xml).toContain('Plenaire opening.');
    expect(blanksBefore(xml, 'Materialen')).toBe(1);
  });

  it('laat geen lege kopregel achter als ITG een kop leegmaakt', async () => {
    const xml = await renderBord(
      bordMet({ 'opdracht.huiswerk': { kop: '' }, 'algemeen.vlag': { kop: '' } }),
      { ...EMPTY_CHECKLIST, homework: true }
    );
    expect(xml).toContain('In overeenstemming met de klant');
    expect(xml).not.toContain('Onder de vlag van');
    expect(legeKoppen(xml)).toBe(0);
  });

  it('begint zonder witregel als de inleiding leeg is', async () => {
    const xml = await renderBord(bordMet({ 'algemeen.inleiding': { tekst: '' } }));
    expect(xml).not.toContain('Binnenkort organiseer');
    // Alleen de vaste ruimte onder de kopband, geen witregel van een sectie erbij.
    expect(blanksBefore(xml, 'Onder de vlag van Incompany Trainer')).toBe(1);
  });

  it('maakt van een fout een zichtbare regel in plaats van de kapotte tekst', async () => {
    const xml = await renderBord(bordMet({ 'algemeen.vlag': { tekst: 'Trainer van {mrek}.' } }));
    // De melding noemt `{mrek}` wél, zodat de adviseur ziet wat er mis is; de zin zelf niet.
    expect(xml).not.toContain('Trainer van {mrek}.');
    expect(xml).toContain('nog niet bepaald: de briefingtekst');
  });

  it('laat de Monday Challenges-regel weg als ITG hem leegmaakt', async () => {
    const xml = await renderBord(bordMet({ 'algemeen.monday-challenges': { tekst: '' } }));
    expect(xml).not.toContain('aan te bieden');
    expect(xml).not.toMatch(/<w:t[^>]*>\+\+\+/);
  });
});
