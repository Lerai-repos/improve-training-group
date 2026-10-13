import { describe, expect, it } from 'vitest';

import { syncAlleLinks, syncLink } from '../run';

import type { LabelCode } from '@lib/labels';
import type { InventarisatieDeps, OpportunityStand } from '../run';

const IT = (id: string): string =>
  `https://www.incompanytrainer.nl/inventarisatie?reference_id=${id}`;

function stel(
  rijen: readonly OpportunityStand[],
  opties: { dryRun?: boolean; faalOp?: string } = {}
): { deps: InventarisatieDeps; geschreven: Array<[string, string | null]> } {
  const geschreven: Array<[string, string | null]> = [];
  const deps: InventarisatieDeps = {
    dryRun: opties.dryRun ?? false,
    websites: () =>
      Promise.resolve(new Map<LabelCode, string>([['IT', 'https://www.incompanytrainer.nl']])),
    leesOpportunity: (itemId) => Promise.resolve(rijen.find((r) => r.itemId === itemId) ?? null),
    leesAlle: () => Promise.resolve(rijen),
    schrijf: (itemId, link) => {
      if (itemId === opties.faalOp) {
        return Promise.reject(new Error('Monday zegt nee'));
      }
      geschreven.push([itemId, link]);
      return Promise.resolve();
    },
  };
  return { deps, geschreven };
}

describe('syncLink', () => {
  it('schrijft de link op een nieuwe Opportunity', async () => {
    const { deps, geschreven } = stel([{ itemId: '1', labelIndex: 1, link: '', tekst: '' }]);
    expect(await syncLink(deps, '1')).toBe('geschreven');
    expect(geschreven).toEqual([['1', IT('1')]]);
  });

  it('schrijft niets als de juiste link er al staat', async () => {
    const { deps, geschreven } = stel([{ itemId: '1', labelIndex: 9, link: IT('1'), tekst: IT('1') }]);
    expect(await syncLink(deps, '1')).toBe('ongewijzigd');
    expect(geschreven).toEqual([]);
  });

  /** De URL is ook de zichtbare tekst, zodat hij te kopiëren is; "klik hier" verbergt hem. */
  it('zet de tekst terug als iemand hem veranderde', async () => {
    const { deps, geschreven } = stel([
      { itemId: '1', labelIndex: 1, link: IT('1'), tekst: 'klik hier' },
    ]);
    expect(await syncLink(deps, '1')).toBe('geschreven');
    expect(geschreven).toEqual([['1', IT('1')]]);
  });

  /** Een gedupliceerde Opportunity neemt de link van het origineel mee, met diens id. */
  it('vervangt de link van een andere Opportunity', async () => {
    const { deps, geschreven } = stel([{ itemId: '2', labelIndex: 1, link: IT('1'), tekst: '' }]);
    expect(await syncLink(deps, '2')).toBe('geschreven');
    expect(geschreven).toEqual([['2', IT('2')]]);
  });

  /** Anders wijst hij naar de website van het vorige label. */
  it('haalt de link weg als het label geen website heeft', async () => {
    const { deps, geschreven } = stel([{ itemId: '1', labelIndex: 14, link: IT('1'), tekst: '' }]);
    expect(await syncLink(deps, '1')).toBe('gewist');
    expect(geschreven).toEqual([['1', null]]);
  });

  it('laat een lege cel leeg als er geen link hoort', async () => {
    const { deps, geschreven } = stel([{ itemId: '1', labelIndex: null, link: '', tekst: '' }]);
    expect(await syncLink(deps, '1')).toBe('ongewijzigd');
    expect(geschreven).toEqual([]);
  });

  it('schrijft niets in een droogloop, maar zegt wel wat hij zou doen', async () => {
    const { deps, geschreven } = stel([{ itemId: '1', labelIndex: 1, link: '', tekst: '' }], {
      dryRun: true,
    });
    expect(await syncLink(deps, '1')).toBe('geschreven');
    expect(geschreven).toEqual([]);
  });

  it('meldt een Opportunity die niet (meer) bestaat', async () => {
    const { deps } = stel([]);
    expect(await syncLink(deps, '9')).toBe('niet-gevonden');
  });
});

describe('syncAlleLinks', () => {
  it('telt per uitkomst, en zet een mislukte schrijfactie apart zonder de rest te stoppen', async () => {
    const { deps, geschreven } = stel(
      [
        { itemId: '1', labelIndex: 1, link: '', tekst: '' },
        { itemId: '2', labelIndex: 1, link: IT('2'), tekst: IT('2') },
        { itemId: '3', labelIndex: 15, link: IT('3'), tekst: '' },
        { itemId: '4', labelIndex: 1, link: '', tekst: '' },
      ],
      { faalOp: '1' }
    );

    const rapport = await syncAlleLinks(deps);

    expect(rapport).toMatchObject({
      opportunities: 4,
      geschreven: 1,
      gewist: 1,
      ongewijzigd: 1,
      mislukt: [{ itemId: '1', fout: 'Monday zegt nee' }],
    });
    expect(geschreven).toEqual([
      ['3', null],
      ['4', IT('4')],
    ]);
  });
});
