import { describe, expect, it } from 'vitest';

import { statusWaarde, updateHtml } from '../knop-deps';

describe('statusWaarde', () => {
  /** Leeg zoals legacy het deed (`value: "{}"`), zodat de knop opnieuw kan. */
  it('maakt Eval Status leeg', () => {
    expect(statusWaarde('leeg')).toEqual({});
  });

  /** Op index: `{"0":"Geen IE-code","1":"RUN"}`, gemeten op Agenda 2026. */
  it('zet Geen IE-code op index 0', () => {
    expect(statusWaarde('geen-ie-code')).toEqual({ index: 0 });
  });

  it('zet ons eigen label op naam, zodat Monday het aanmaakt', () => {
    expect(statusWaarde('zie-systeembord')).toEqual({ label: 'Zie Systeem-bord' });
  });
});

describe('updateHtml', () => {
  it('maakt van regels <br> en ontsnapt HTML', () => {
    expect(updateHtml('Code <260814> & "x"\n\nOpnieuw')).toBe(
      'Code &lt;260814&gt; &amp; &quot;x&quot;<br><br>Opnieuw'
    );
  });
});
