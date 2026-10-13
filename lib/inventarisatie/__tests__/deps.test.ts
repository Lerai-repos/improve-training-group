import { describe, expect, it } from 'vitest';

import { linkWaarde } from '../deps';

describe('linkWaarde', () => {
  it('zet de URL ook als zichtbare tekst, zodat hij te kopiëren is', () => {
    expect(linkWaarde('https://www.workjoy.nl/inventarisatie?reference_id=1')).toEqual({
      url: 'https://www.workjoy.nl/inventarisatie?reference_id=1',
      text: 'https://www.workjoy.nl/inventarisatie?reference_id=1',
    });
  });

  it('maakt de cel leeg zonder link', () => {
    expect(linkWaarde(null)).toEqual({});
  });
});
