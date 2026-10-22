import { readFileSync } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { composeBriefing } from '../compose';
import { LOGO_RELATIE, leesLogo, metLogo, pasIn } from '../logo';
import {
  ALGEMEEN_SJABLOON,
  heeftEigenSjabloon,
  renderBriefing,
  sjabloonVoor,
  TEMPLATES_DIR,
} from '../render';
import { standaardTekstenVoor } from '../teksten';

import type { LabelLogo } from '../logo';
import type { BriefingTraining } from '../types';

/**
 * Het algemene sjabloon en het logo erin, op een écht sjabloon.
 *
 * Een label dat ITG zelf op het Labels-bord zet heeft geen eigen sjabloon. Gaat het vervangen van
 * het logo mis, dan opent het document gewoon — met een leeg vlak, of met een uitgerekt logo — en
 * merkt niemand het tot een trainer het ziet. Vandaar: renderen en de zip in.
 */

/** Het logo uit het TT-sjabloon: een echt bestand van 4913 bij 953 pixels. */
async function ttLogo(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(readFileSync(path.join(TEMPLATES_DIR, 'TT.docx')));
  const bestand = zip.file('word/media/image5.png');
  if (bestand === null) {
    throw new Error('TT.docx heeft geen image5.png meer; kies een ander testlogo');
  }
  return bestand.async('uint8array');
}

/** Een JPEG van 1 bij 1 pixel, met een SOF0 die 300 breed en 100 hoog zegt. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x01,
  0x2c, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

const TRAINING: BriefingTraining = {
  itemId: '1',
  naam: 'Probiblio',
  label: 'ITG',
  brie: 'Aanmaken',
  opdrachtgever: 'Probiblio',
  themas: ['Verbindend communiceren'],
  trainingscodeMc: '',
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

/** Met de teksten van TT, zodat de term "Teambuilding" is en niet de standaard. */
const data = composeBriefing(TRAINING, EMPTY_CHECKLIST, { teksten: standaardTekstenVoor('TT') });

describe('sjabloonVoor', () => {
  it('kiest het eigen sjabloon van een van de negen labels, hoe het ook geschreven is', () => {
    expect(sjabloonVoor('IT')).toMatchObject({
      eigen: true,
      pad: expect.stringMatching(/IT\.docx$/),
    });
    expect(sjabloonVoor(' sst ')).toMatchObject({
      eigen: true,
      pad: expect.stringMatching(/SST\.docx$/),
    });
  });

  /** `WorkJoy` op de agenda is `WJ`, en dat heeft een eigen sjabloon. */
  it('kiest het eigen sjabloon ook via een schrijfwijze', () => {
    expect(sjabloonVoor('WorkJoy')).toMatchObject({
      eigen: true,
      pad: expect.stringMatching(/WJ\.docx$/),
    });
  });

  it('valt voor elk ander label terug op het algemene sjabloon', () => {
    for (const label of ['ITG', 'YNS', 'ST - StressTrainer', '../../etc/passwd']) {
      expect(sjabloonVoor(label)).toEqual({
        eigen: false,
        pad: path.join(TEMPLATES_DIR, ALGEMEEN_SJABLOON),
      });
    }
  });

  it('weigert een training zonder label', () => {
    expect(() => sjabloonVoor('  ')).toThrow(/geen label/);
    expect(heeftEigenSjabloon('')).toBe(false);
  });
});

describe('leesLogo', () => {
  it('leest de afmeting van een PNG', async () => {
    const logo = leesLogo(await ttLogo(), 'tt.png');
    expect(logo).toMatchObject({ soort: 'png', breedte: 4913, hoogte: 953 });
  });

  it('leest de afmeting van een JPEG uit de SOF', () => {
    expect(leesLogo(JPEG, 'x.jpg')).toMatchObject({ soort: 'jpeg', breedte: 300, hoogte: 100 });
  });

  it('weigert iets anders, met de naam erbij', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => leesLogo(svg, 'logo.svg')).toThrow(/logo\.svg.*PNG of JPEG/);
  });
});

describe('pasIn', () => {
  it('houdt de hoogte van het vak voor een smal logo', () => {
    expect(pasIn({ cx: 1000, cy: 100 }, { breedte: 2, hoogte: 1 })).toEqual({ cx: 200, cy: 100 });
  });

  it('houdt de breedte van het vak voor een breed logo', () => {
    expect(pasIn({ cx: 1000, cy: 100 }, { breedte: 20, hoogte: 1 })).toEqual({ cx: 1000, cy: 50 });
  });
});

describe('renderBriefing met het algemene sjabloon', () => {
  it('weigert zonder logo, in plaats van een document zonder merk te maken', async () => {
    await expect(renderBriefing('ITG', data)).rejects.toThrow(/logo van het Labels-bord/);
  });

  it('zet het logo op beide plekken, met de eigen verhouding, en de term in de tabel', async () => {
    const logo = leesLogo(await ttLogo(), 'tt.png');
    const zip = await JSZip.loadAsync(await renderBriefing('ITG', data, { logo }));

    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/labellogo'));
    expect(media.sort()).toEqual(['word/media/labellogo1.png', 'word/media/labellogo2.png']);
    for (const naam of media) {
      expect(await zip.file(naam)?.async('uint8array')).toEqual(logo.bytes);
    }

    for (const onderdeel of ['word/document.xml', 'word/footer1.xml']) {
      const xml = (await zip.file(onderdeel)?.async('string')) ?? '';
      const tekening = [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)]
        .map((m) => m[0])
        .find((t) => t.includes(`r:embed="${LOGO_RELATIE}"`));
      const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(tekening ?? '');
      expect(extent, onderdeel).not.toBeNull();
      const verhouding = Number(extent?.[1]) / Number(extent?.[2]);
      expect(verhouding).toBeCloseTo(logo.breedte / logo.hoogte, 2);
    }

    const tekst = ((await zip.file('word/document.xml')?.async('string')) ?? '').replace(
      /<[^>]+>/g,
      ''
    );
    expect(tekst).toContain('Teambuilding');
    expect(tekst).not.toContain('+++');
  });

  it('zet een JPEG-logo onder de juiste extensie, met relaties die ernaar wijzen', async () => {
    const logo: LabelLogo = leesLogo(JPEG, 'x.jpg');
    const zip = await JSZip.loadAsync(await renderBriefing('ITG', data, { logo }));
    expect(
      Object.keys(zip.files)
        .filter((n) => n.startsWith('word/media/labellogo'))
        .sort()
    ).toEqual(['word/media/labellogo1.jpeg', 'word/media/labellogo2.jpeg']);
    const rels =
      ((await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '') +
      ((await zip.file('word/_rels/footer1.xml.rels')?.async('string')) ?? '');
    expect(rels).toContain('Target="media/labellogo1.jpeg"');
    expect(rels).toContain('Target="media/labellogo2.jpeg"');
    expect(rels).not.toContain('labellogo1.png');
  });

  it('laat een eigen sjabloon ongemoeid, ook als er een logo meekomt', async () => {
    const logo = leesLogo(await ttLogo(), 'tt.png');
    const zip = await JSZip.loadAsync(
      await renderBriefing(
        'IT',
        composeBriefing({ ...TRAINING, label: 'IT' }, EMPTY_CHECKLIST, {}),
        { logo }
      )
    );
    expect(Object.keys(zip.files).some((n) => n.includes('labellogo'))).toBe(false);
  });
});

describe('metLogo', () => {
  it('weigert een document zonder logoplek', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types></Types>');
    zip.file('word/_rels/document.xml.rels', '<Relationships></Relationships>');
    const leeg = await zip.generateAsync({ type: 'uint8array' });
    await expect(metLogo(leeg, leesLogo(JPEG, 'x.jpg'))).rejects.toThrow(/geen plek voor het logo/);
  });
});

describe('standaardTekstenVoor', () => {
  /** De voorvertoning van een FT-training: merk en term van de beginrij, onder elke naam. */
  it.each(['FT', 'Feedbacktrainer', 'Feedback Trainer'])(
    'vult merk en term in voor %j',
    (label) => {
      expect(standaardTekstenVoor(label)).toMatchObject({
        merk: 'Feedback Trainer',
        term: 'training',
      });
    }
  );
});
