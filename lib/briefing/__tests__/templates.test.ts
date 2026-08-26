import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { composeBriefing } from '../compose';
import { resolveRecipientRoles } from '../recipients';
import { renderBriefing, TEMPLATES_DIR } from '../render';
import { zipReadText } from './zip-reader';

import type { BriefingTraining } from '../types';

/**
 * De opbouw van de negen sjablonen zelf, en van wat er uit komt.
 *
 * `render.test.ts` rendert alléén `IT`. Dat is genoeg om te controleren of de commando's
 * werken, maar niet of de negen sjablonen dezelfde opbouw hebben — en die opbouw is precies
 * wat op 24-Aug-2026 verbouwd is: de gegevenstabel uit het tekstvak, de gele markering eruit,
 * echte opsommingstekens, en de rolblokken boven `Concept inhoud`.
 *
 * Elk van die vier faalt **stil**. Een sjabloon dat opnieuw gegenereerd wordt met een oudere
 * `convert.py` levert een document op dat prima opent, waarin Word de tabel gewoon toont, en
 * waarin alleen Google Docs de hele tabel weglaat. Geen enkele bestaande test merkt dat.
 *
 * Daarom staan de controles hier op de XML en niet op de tekst: de tekst is in beide gevallen
 * identiek. Zie het geheugen `itg-briefing-sjabloonopbouw` voor het waarom van elke keuze.
 */

const LABELS = ['CC', 'CP', 'FT', 'FV', 'IT', 'JE', 'SST', 'TT', 'WJ'] as const;

/** Het eerste veld van de gegevenstabel; waar dit staat, staat de tabel. */
const TABLE_MARKER = '+++opdrachtgever+++';
/** De alinea die per concept-regel herhaald wordt. */
const CONCEPT_LINE = '+++$b+++';
/** De alinea die per blokregel herhaald wordt, in de opsommingsvariant. */
const BLOCK_LINE = '+++$r.tekst+++';

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

  /** Cyaan blijft juist wél staan: dat is de opmerking over de Monday Challenges. */
  it('houdt de cyaan markering', () => {
    expect(templateXml(label)).toMatch(highlight('cyan'));
  });

  it('geeft de concept-regel een echt opsommingsteken', () => {
    const xml = templateXml(label);
    expect(paragraphAt(xml, positionOf(xml, CONCEPT_LINE))).toContain('<w:numPr>');
  });

  /**
   * Twee varianten van dezelfde regel, want `docx-templates` kan tekst weglaten maar geen
   * alinea-opmaak omzetten. Precies één ervan hoort een opsommingsteken te hebben; zijn het
   * er twee, dan wordt élke blokregel een bullet, en nul betekent geen enkele.
   */
  it('rendert blokregels in een opsommings- en een gewone variant', () => {
    const xml = templateXml(label);
    const eerste = positionOf(xml, BLOCK_LINE);
    const tweede = xml.indexOf(BLOCK_LINE, eerste + BLOCK_LINE.length);
    expect(tweede).toBeGreaterThan(-1);
    const met = [eerste, tweede].filter((at) => paragraphAt(xml, at).includes('<w:numPr>'));
    expect(met).toHaveLength(1);
  });

  /**
   * Tim, 24-Aug-2026: *"i think it should be above the concept inhoud. So the page starts
   * with that."* De trainer leest eerst wat er van hém verwacht wordt, dan pas het programma.
   */
  it('zet de rolblokken boven Concept inhoud en de rest eronder', () => {
    const xml = templateXml(label);
    const rol = positionOf(xml, '+++FOR blk IN rolblokken+++');
    const kop = positionOf(xml, 'Concept inhoud');
    const rest = positionOf(xml, '+++FOR blk IN blokken+++');
    expect(rol).toBeLessThan(kop);
    expect(kop).toBeLessThan(rest);
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
  missing: [],
};

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
    composeBriefing(training, EMPTY_CHECKLIST, { historie: [], recipient: lead })
  );
  return zipReadText(bytes, 'word/document.xml');
}

/**
 * Dezelfde vier eigenschappen, maar dan in het document dat een trainer opent. Het sjabloon
 * kan kloppen terwijl het renderen ze alsnog kwijtraakt — zo verdween "Jij bent de
 * leadtrainer en dus verantwoordelijk voor:" toen `docx-templates` de `<w:br/>` binnen de
 * `<w:t>` zette.
 */
describe.each(LABELS)('gerenderde briefing %s', (label) => {
  it('houdt de gegevenstabel buiten een tekstvak', async () => {
    const xml = await renderLead(label);
    expect(insideBox(xml, positionOf(xml, 'Opdrachtgever'))).toBe(false);
  });

  it('heeft geen gele markering', async () => {
    expect(await renderLead(label)).not.toMatch(highlight('yellow'));
  });

  it('geeft de concept-regels een opsommingsteken', async () => {
    const xml = await renderLead(label);
    expect(paragraphAt(xml, positionOf(xml, 'Plenaire opening.'))).toContain('<w:numPr>');
  });

  it('geeft de taken van de leadtrainer een opsommingsteken', async () => {
    const xml = await renderLead(label);
    expect(paragraphAt(xml, positionOf(xml, 'Ontwikkelen van training'))).toContain('<w:numPr>');
  });

  it('zet het rolblok boven Concept inhoud', async () => {
    const xml = await renderLead(label);
    expect(positionOf(xml, 'Leadtrainer')).toBeLessThan(positionOf(xml, 'Concept inhoud'));
  });

  /**
   * `<w:br/>` hoort een broer van `<w:t>` te zijn, niet een kind. Stond het erbinnen, dan
   * werd de tekst erna een tail die uit het document verdween — zonder dat iets faalde.
   */
  it('zet regelafbrekingen buiten w:t', async () => {
    const xml = await renderLead(label);
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*<w:br\/>/);
  });
});
