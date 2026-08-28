import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST, type BriefingChecklist, type HistoryRow } from '../blocks';
import { resolveRecipientRoles } from '../recipients';
import { composeBriefing } from '../compose';
import { renderBriefing } from '../render';
import { zipNames, zipReadText } from './zip-reader';

import type { BriefingTraining } from '../types';

/**
 * Deze tests renderen een écht sjabloon uit `lib/briefing/templates/`.
 *
 * Dat is met opzet: de laag die het vaakst stil kapot gaat is niet de code maar de sjabloon,
 * en die faalt nooit hard. Een `+++FOR+++` op de verkeerde plek levert een document op dat
 * prima opent en waarin alleen de helft ontbreekt. Alleen de uitvoer inspecteren vangt dat.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const TRAINING: BriefingTraining = {
  itemId: '1',
  naam: 'Probiblio',
  label: 'IT',
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
  missing: [],
};

const HISTORY: HistoryRow[] = [
  {
    datum: '12-01-2026',
    tijd: '09:30 - 12:30',
    klanttitel: 'Speeddaten & Verbindend communiceren',
    trainer: 'Tessa de Haas (06-24118840)',
    contactpersoon: 'Paula Hollander',
  },
  {
    datum: '03-06-2026',
    tijd: '13:00 - 16:00',
    klanttitel: 'Feedback geven en ontvangen',
    trainer: 'Lennart Bosschaart (06-18683139)',
    contactpersoon: 'Paula Hollander',
  },
];

/** Het document uitpakken tot iets waar we op kunnen kijken. */
function documentXml(bytes: Uint8Array): string {
  return zipReadText(bytes, 'word/document.xml');
}

/** Alleen echte bestanden: een zip bevat ook een ingang voor de map `word/media/` zelf. */
function mediaEntries(bytes: Uint8Array): string[] {
  return zipNames(bytes).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'));
}

/** Word schrijft `&` als `&amp;`, en een klanttitel als "Speeddaten & …" heeft er een. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** De rijen van elke tabel met vijf kolommen: dat is de historie-tabel en niets anders. */
function historyRows(xml: string): string[][] {
  const rows: string[][] = [];
  for (const table of xml.split('<w:tbl>').slice(1)) {
    const body = table.split('</w:tbl>')[0] ?? '';
    const parsed = body
      .split('<w:tr')
      .slice(1)
      .map((row) => {
        const cells = row.split('</w:tr>')[0]?.split('<w:tc>').slice(1) ?? [];
        return cells.map((cell) =>
          unescapeXml(
            [...cell.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
          ).trim()
        );
      });
    if (parsed.length > 0 && parsed[0]?.length === 5) {
      rows.push(...parsed);
    }
  }
  return rows;
}

async function render(checklist: BriefingChecklist, historie?: readonly HistoryRow[]) {
  return renderBriefing('IT', composeBriefing(TRAINING, checklist, { historie }));
}

describe('renderBriefing', () => {
  it('vult elk veld in; er blijft geen commando staan', async () => {
    const xml = documentXml(await render(EMPTY_CHECKLIST, []));
    const plain = xml.replace(/<[^>]+>/g, '');
    expect(plain).not.toContain('+++');
    expect(plain).toContain('Probiblio');
  });

  /**
   * De historie hoort een échte tabel te zijn: `*** INVOEGEN *** Tabel met onderstaande
   * kolommen` staat letterlijk in ITG's bronbestand. Alinea's met streepjes ertussen vallen
   * uit elkaar zodra een klanttitel over twee regels loopt.
   */
  it('zet de historie in een tabel met een koprij en één rij per sessie', async () => {
    const rows = historyRows(documentXml(await render(EMPTY_CHECKLIST, HISTORY)));
    expect(rows).toEqual([
      ['Datum', 'Tijd', 'Klanttitel', 'Trainer (tel nr)', 'CP klant'],
      [
        '12-01-2026',
        '09:30 - 12:30',
        'Speeddaten & Verbindend communiceren',
        'Tessa de Haas (06-24118840)',
        'Paula Hollander',
      ],
      [
        '03-06-2026',
        '13:00 - 16:00',
        'Feedback geven en ontvangen',
        'Lennart Bosschaart (06-18683139)',
        'Paula Hollander',
      ],
    ]);
  });

  /**
   * De lusregels van het sjabloon mogen niet als lege rijen achterblijven. Ze zijn er alleen
   * omdat docx-templates de datarij anders niet als rij herhaalt.
   */
  it('laat geen lege commandorijen achter', async () => {
    const rows = historyRows(documentXml(await render(EMPTY_CHECKLIST, HISTORY)));
    expect(rows.every((r) => r.some((c) => c !== ''))).toBe(true);
    expect(rows).toHaveLength(1 + HISTORY.length);
  });

  it('laat de hele tabel weg als er geen eerdere sessies zijn', async () => {
    expect(historyRows(documentXml(await render(EMPTY_CHECKLIST, [])))).toEqual([]);
  });

  /** `06-briefing.md`: het cyclusblok is de uitleg **plus het cyclusschema als afbeelding**. */
  it('sluit het cyclusschema in bij een trainingscyclus', async () => {
    const met = await render({ ...EMPTY_CHECKLIST, trainingCycle: true }, []);
    const zonder = await render(EMPTY_CHECKLIST, []);
    expect(mediaEntries(met).length).toBe(mediaEntries(zonder).length + 1);

    const xml = documentXml(met).replace(/<[^>]+>/g, '');
    expect(xml).toContain('Grofweg zie de cyclus ziet er als onderstaand uit');
  });

  /**
   * De concept-inhoud loopt van het Themas-bord tot in het Word-document, inclusief het
   * invullen van de organisatienaam. Alleen `compose` testen zou missen dat de bullets in
   * het sjabloon op de verkeerde plek herhaald worden.
   */
  it('zet de bullets van het thema in het document, met de organisatienaam ingevuld', async () => {
    const training: BriefingTraining = {
      ...TRAINING,
      opdrachtgever: 'Probiblio',
      trainingscodeMc: '',
      themaInhoud:
        'Plenaire opening, kennismaking en introductie tot het onderwerp.\n' +
        'Reflectie: hoe staat het er nu voor met feedback binnen {organisatie} en binnen deze groep?',
    };
    const xml = documentXml(
      await renderBriefing('IT', composeBriefing(training, EMPTY_CHECKLIST, { historie: [] }))
    );
    expect(xml).toContain('Plenaire opening, kennismaking en introductie tot het onderwerp.');
    expect(xml).toContain('feedback binnen Probiblio en binnen deze groep');
    expect(xml).not.toContain('{organisatie}');
  });

  it('laat de tekst van de adviseur winnen van het skelet van het thema', async () => {
    const training: BriefingTraining = { ...TRAINING, themaInhoud: 'Het standaardskelet.' };
    const checklist: BriefingChecklist = {
      ...EMPTY_CHECKLIST,
      conceptInhoud: 'De versie van de adviseur.',
    };
    const xml = documentXml(
      await renderBriefing('IT', composeBriefing(training, checklist, { historie: [] }))
    );
    expect(xml).toContain('De versie van de adviseur.');
    expect(xml).not.toContain('Het standaardskelet.');
  });

  /**
   * De rolblokken tot in het Word-document. De lead- en co-tekst beweren het
   * tegenovergestelde over wie het klantcontact doet, dus dit is de plek waar het echt
   * misgaat als de verkeerde variant wordt gekozen.
   */
  describe('rolblokken per ontvanger', () => {
    const LENNART = {
      itemId: '1',
      naam: 'Lennart Bosschaart',
      telefoon: '0618683139',
      isActeur: false,
      isCoTrainer: false,
    };
    const TESSA = {
      itemId: '2',
      naam: 'Tessa de Haas',
      telefoon: '0624118840',
      isActeur: false,
      isCoTrainer: true,
    };
    const ELKE = {
      itemId: '3',
      naam: 'Elke Jansen',
      telefoon: '0611111111',
      isActeur: true,
      isCoTrainer: false,
    };

    const renderFor = async (
      trainers: BriefingTraining['trainers'],
      naam: string,
      checklist: BriefingChecklist = EMPTY_CHECKLIST
    ) => {
      const training: BriefingTraining = { ...TRAINING, trainers, acteuraantal: 1 };
      const uit = resolveRecipientRoles(training, checklist);
      if (uit.kind !== 'resolved') {
        throw new Error(`rollen niet opgelost: ${uit.kind}`);
      }
      const recipient = uit.recipients.find((r) => r.trainer.naam === naam);
      if (recipient === undefined) {
        throw new Error(`${naam} is geen ontvanger`);
      }
      return documentXml(
        await renderBriefing(
          'IT',
          composeBriefing(training, checklist, { historie: [], recipient })
        )
      );
    };

    it('geeft de lead de leadtekst, met de co-trainer erin genoemd', async () => {
      const xml = await renderFor([LENNART, TESSA], 'Lennart Bosschaart');
      expect(xml).toContain('Jij bent de leadtrainer');
      expect(xml).not.toContain('Jij bent ingedeeld als co-trainer');
      expect(xml).toContain('Tessa de Haas (06-24118840)');
      expect(xml).not.toContain('Naam (tel nr)');
    });

    it('geeft de co-trainer de co-tekst, met de lead erin genoemd', async () => {
      const xml = await renderFor([LENNART, TESSA], 'Tessa de Haas');
      expect(xml).toContain('Jij bent ingedeeld als co-trainer');
      expect(xml).not.toContain('Jij bent de leadtrainer');
      expect(xml).toContain('Lennart Bosschaart (06-18683139)');
    });

    /** Klantcontactmoment verschilt per rol; dit is Dirkje's eigen tweede voorstel. */
    it('zet Klantcontactmoment op n.v.t. voor de co-trainer', async () => {
      const xml = await renderFor([LENNART, TESSA], 'Tessa de Haas');
      expect(xml).toContain('n.v.t., door lead trainer');
    });

    it('laat Klantcontactmoment staan voor de lead', async () => {
      const xml = await renderFor([LENNART, TESSA], 'Lennart Bosschaart');
      expect(xml).not.toContain('n.v.t., door lead trainer');
    });

    it('geeft de acteur de acteurtekst, met de trainer erin genoemd', async () => {
      const met = { ...EMPTY_CHECKLIST, trainingActor: true };
      const xml = await renderFor([LENNART, ELKE], 'Elke Jansen', met);
      expect(xml).toContain('word je ingezet als trainingsacteur');
      expect(xml).not.toContain('werk je met een trainingsacteur');
      expect(xml).toContain('Lennart Bosschaart (06-18683139)');
    });

    it('geeft de trainer op diezelfde sessie het "werken met" blok', async () => {
      const met = { ...EMPTY_CHECKLIST, trainingActor: true };
      const xml = await renderFor([LENNART, ELKE], 'Lennart Bosschaart', met);
      expect(xml).toContain('werk je met een trainingsacteur');
      expect(xml).toContain('Elke Jansen (06-11111111)');
    });

    /** Eén trainer, geen acteur: er valt niets af te stemmen, dus geen rolblok. */
    it('geeft een enkele trainer geen rolblok', async () => {
      const xml = await renderFor([LENNART], 'Lennart Bosschaart');
      expect(xml).not.toContain('Jij bent de leadtrainer');
      expect(xml).not.toContain('trainingsacteur');
    });
  });

  it('weigert een label zonder sjabloon in plaats van er een te kiezen', async () => {
    await expect(
      renderBriefing('ZZZ', composeBriefing(TRAINING, EMPTY_CHECKLIST, { historie: [] }))
    ).rejects.toThrow();
  });
});

/** Het namespace-adres wordt alleen gebruikt om te bevestigen dat we echte OOXML lezen. */
it('leest een geldig Word-document', async () => {
  expect(documentXml(await render(EMPTY_CHECKLIST, []))).toContain(W);
});
