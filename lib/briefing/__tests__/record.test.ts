import { describe, expect, it } from 'vitest';

import {
  createBriefingRecorder,
  recordGeneration,
  recordInputFor,
  type BriefingRecorder,
  type BriefingRow,
} from '../record';

import type { MondayMutationClient } from '@lib/monday/mutate';

/**
 * De administratie ná het schrijven van de documenten.
 *
 * Het draait hier om één eigenschap: op dit moment staan de briefings al in de klantmap, dus
 * niets van wat hier misgaat mag de generatie alsnog laten mislukken.
 */

function recorder(
  falen: { rij?: boolean; brie?: boolean } = {}
): BriefingRecorder & { rijen: readonly BriefingRow[]; brie: readonly string[] } {
  const rijen: BriefingRow[] = [];
  const brie: string[] = [];
  return {
    rijen,
    brie,
    addRow: (row) => {
      if (falen.rij === true) {
        return Promise.reject(new Error('Monday down'));
      }
      rijen.push(row);
      return Promise.resolve(`row-${rijen.length}`);
    },
    setBrie: (_itemId, status) => {
      if (falen.brie === true) {
        return Promise.reject(new Error('kolom weg'));
      }
      brie.push(status);
      return Promise.resolve();
    },
  };
}

const INVOER = {
  trainingItemId: '900',
  rows: [
    {
      filename: 'Briefing Calduran - Feedback - 09-10-2026 - Frank.docx',
      ontvanger: 'Frank Paats',
      role: 'lead' as const,
      url: 'https://sp/frank.docx',
    },
    {
      filename: 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx',
      ontvanger: 'Richard Roling',
      role: 'co' as const,
      url: 'https://sp/richard.docx',
    },
  ],
  incompleet: false,
  vandaag: '2026-08-26',
};

/**
 * De echte recorder tegen een nagebootste MUTATIE-client.
 *
 * Deze suite bestaat om één reden: de recorder was getypeerd op de LEESclient, en die
 * weigert elk document waar `mutation` in staat. Elke rij en elke statuswijziging wierp dus,
 * `recordGeneration` ving dat netjes op als "administratie niet bijgewerkt", en de route
 * meldde succes — terwijl er in Monday nooit iets verscheen. Een test die alleen de
 * foutpaden afdekt ziet dat niet; deze legt het geslaagde pad vast.
 */
describe('createBriefingRecorder', () => {
  function mutatieClient(): MondayMutationClient & { documenten: readonly string[] } {
    const documenten: string[] = [];
    return {
      documenten,
      mutate: <T>(document: string): Promise<T> => {
        documenten.push(document);
        // Wat `create_item` teruggeeft; `setBrie` kijkt er niet naar.
        return Promise.resolve({ create_item: { id: '42' } } as T);
      },
    };
  }

  it('maakt een rij aan via de mutatieclient', async () => {
    const client = mutatieClient();

    const id = await createBriefingRecorder(client, '5087396949').addRow({
      trainingItemId: '900',
      filename: 'Briefing.docx',
      ontvanger: 'Frank Paats',
      role: 'lead',
      url: 'https://sp/b.docx',
      gegenereerdOp: '2026-08-26',
    });

    expect(id).toBe('42');
    expect(client.documenten[0]).toContain('create_item');
  });

  it('zet de statuskolom via de mutatieclient', async () => {
    const client = mutatieClient();

    await createBriefingRecorder(client, '5087396949').setBrie('900', 'Staat klaar');

    expect(client.documenten[0]).toContain('change_simple_column_value');
  });

  /**
   * Het hele pad achter elkaar, zonder één ingebouwde mislukking: twee rijen én de status,
   * en géén enkele klacht. Precies wat er niet gebeurde toen de leesclient erin zat.
   */
  it('legt een volledige generatie vast zonder problemen te melden', async () => {
    const client = mutatieClient();

    const uit = await recordGeneration(createBriefingRecorder(client, '5087396949'), INVOER);

    expect(uit).toEqual({ brie: 'Staat klaar', problemen: [] });
    expect(client.documenten).toHaveLength(3);
  });
});

describe('recordInputFor', () => {
  const documenten = [
    { trainerNaam: 'Frank Paats', role: 'lead' as const, open: [] },
    { trainerNaam: 'Richard Roling', role: 'co' as const, open: [] },
  ];
  const bestand = (naam: string) => ({ file: { name: naam, webUrl: `https://sp/${naam}` } });

  it('maakt één rij per geschreven bestand', () => {
    const uit = recordInputFor({
      trainingItemId: '900',
      documents: documenten,
      written: [bestand('a.docx'), bestand('b.docx')],
      vandaag: '2026-08-26',
    });

    expect(uit.rows.map((rij) => [rij.filename, rij.ontvanger, rij.role])).toEqual([
      ['a.docx', 'Frank Paats', 'lead'],
      ['b.docx', 'Richard Roling', 'co'],
    ]);
    expect(uit.incompleet).toBe(false);
  });

  /**
   * HET geval waarvoor dit apart staat.
   *
   * Bij een deelresultaat zijn er minder geschreven bestanden dan gerenderde documenten. Over
   * de gerenderde lopen leverde bij het eerste ontbrekende bestand een `undefined` op — een
   * 500 waarbij níets werd vastgelegd, en dus precies de wees die het deelresultaat hoort te
   * voorkomen.
   */
  it('legt bij een halve generatie vast wat er wél staat', () => {
    const uit = recordInputFor({
      trainingItemId: '900',
      documents: documenten,
      written: [bestand('a.docx')],
      vandaag: '2026-08-26',
    });

    expect(uit.rows).toHaveLength(1);
    expect(uit.rows[0].ontvanger).toBe('Frank Paats');
  });

  /** `Staat klaar` boven een training waarvan de helft ontbreekt is domweg onwaar. */
  it('noemt een halve generatie onvolledig', () => {
    const uit = recordInputFor({
      trainingItemId: '900',
      documents: documenten,
      written: [bestand('a.docx')],
      vandaag: '2026-08-26',
    });

    expect(uit.incompleet).toBe(true);
  });

  it('noemt een volledige generatie met lege velden ook onvolledig', () => {
    const uit = recordInputFor({
      trainingItemId: '900',
      documents: [{ ...documenten[0], open: ['Achtergrondinformatie'] }],
      written: [bestand('a.docx')],
      vandaag: '2026-08-26',
    });

    expect(uit.incompleet).toBe(true);
  });
});

describe('recordGeneration', () => {
  it('maakt één rij per document en zet Brie op klaar', async () => {
    const r = recorder();

    const uit = await recordGeneration(r, INVOER);

    expect(uit).toEqual({ brie: 'Staat klaar', problemen: [] });
    expect(r.rijen.map((rij) => [rij.ontvanger, rij.role])).toEqual([
      ['Frank Paats', 'lead'],
      ['Richard Roling', 'co'],
    ]);
    // De relatie draagt de betekenis; de drie spiegelkolommen vullen zichzelf.
    expect(r.rijen[0].trainingItemId).toBe('900');
    expect(r.rijen[0].gegenereerdOp).toBe('2026-08-26');
    expect(r.brie).toEqual(['Staat klaar']);
  });

  /**
   * Dirkje's eigen wens was *"joh, er ontbreekt nog informatie"*. Het document komt er wel,
   * met een zichtbare regel op de lege plek, en de status zegt dat het nog niet af is.
   */
  it('zet Brie op onvolledig als er velden ontbraken', async () => {
    const r = recorder();

    const uit = await recordGeneration(r, { ...INVOER, incompleet: true });

    expect(uit.brie).toBe('Begonnen, niet klaar');
    expect(r.brie).toEqual(['Begonnen, niet klaar']);
  });

  /**
   * HET punt van dit bestand.
   *
   * De briefings staan al in SharePoint. Zou dit werpen, dan hoort de adviseur dat het
   * genereren is mislukt terwijl de trainer zijn document gewoon kan openen — en probeert
   * hij het opnieuw, met een overbodige `(v2)` als resultaat.
   */
  it('laat een mislukte rij de generatie niet omgooien', async () => {
    const r = recorder({ rij: true });

    const uit = await recordGeneration(r, INVOER);

    expect(uit.brie).toBe('Staat klaar');
    expect(uit.problemen).toHaveLength(2);
    expect(uit.problemen[0]).toContain('Frank Paats');
    // En de status is er ondanks de mislukte rijen wél gezet.
    expect(r.brie).toEqual(['Staat klaar']);
  });

  it('meldt een mislukte statuskolom zonder te werpen', async () => {
    const r = recorder({ brie: true });

    const uit = await recordGeneration(r, INVOER);

    expect(uit.problemen).toEqual(['Brie niet op "Staat klaar" gezet: kolom weg']);
    // De rijen zijn er wel: het één blokkeert het ander niet.
    expect(r.rijen).toHaveLength(2);
  });

  /**
   * Bij opnieuw genereren komt er een rij bíj in plaats van dat de oude wordt bijgewerkt.
   * Een `(v2)` is een ander bestand met een eigen link, en de oude rij overschrijven zou
   * verbergen dat die eerdere versie er nog ligt.
   */
  it('voegt bij een tweede generatie rijen toe in plaats van te vervangen', async () => {
    const r = recorder();

    await recordGeneration(r, INVOER);
    await recordGeneration(r, {
      ...INVOER,
      rows: [
        {
          ...INVOER.rows[0],
          filename: 'Briefing Calduran - Feedback - 09-10-2026 - Frank (v2).docx',
          url: 'https://sp/frank-v2.docx',
        },
      ],
      vandaag: '2026-08-27',
    });

    expect(r.rijen).toHaveLength(3);
    expect(r.rijen[2].filename).toContain('(v2)');
    expect(r.rijen[2].gegenereerdOp).toBe('2026-08-27');
  });
});
