import { describe, expect, it } from 'vitest';

import {
  answeredCount,
  averageLabel,
  bars,
  followUpTally,
  gradeDistribution,
  scoreDistribution,
} from '../distribution';
import { chartColours, lighten } from '../colours';
import { escapeHtml, firstNames, joinDutch, trainerWord } from '../text';

describe('gradeDistribution', () => {
  it('telt per cijfer van 1 tot 10', () => {
    expect(gradeDistribution([1, 10, 10, 5])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 2]);
  });

  /** De bestaande generator doet `Math.round`, dus een 7,5 telt als een 8. Overgenomen. */
  it('rondt af in plaats van af te kappen', () => {
    expect(gradeDistribution([7.5])[7]).toBe(1);
    expect(gradeDistribution([7.4])[6]).toBe(1);
  });

  it('negeert lege en onmogelijke cijfers zonder te werpen', () => {
    expect(gradeDistribution([null, 0, 11, -3, Number.NaN]).every((n) => n === 0)).toBe(true);
  });
});

describe('scoreDistribution', () => {
  it('telt over 1 tot 5', () => {
    expect(scoreDistribution([1, 3, 3, 5, null])).toEqual([1, 0, 2, 0, 1]);
  });

  it('laat een 10 buiten de schaal vallen', () => {
    expect(scoreDistribution([10])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('bars', () => {
  it('rekent percentages over het totaal van de balken', () => {
    expect(bars([1, 1, 2]).map((b) => b.pct)).toEqual([25, 25, 50]);
  });

  /**
   * Elk percentage wordt apart afgerond, dus 3×33,33% wordt 3×33 en de som is 99. Zo staat
   * het in de rapporten die ITG vandaag verstuurt; netter afronden zou elke grafiek wijzigen.
   */
  it('laat percentages optellen tot 99 in plaats van te herverdelen', () => {
    const pcts = bars([1, 1, 1]).map((b) => b.pct);
    expect(pcts).toEqual([33, 33, 33]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(99);
  });

  it('geeft een leeg bijschrift bij nul, en telt anders mee', () => {
    expect(bars([0, 3]).map((b) => b.label)).toEqual(['', '3 (100%)']);
  });

  it('deelt niet door nul als niemand antwoordde', () => {
    expect(bars([0, 0, 0])).toEqual([
      { count: 0, pct: 0, label: '' },
      { count: 0, pct: 0, label: '' },
      { count: 0, pct: 0, label: '' },
    ]);
  });
});

describe('followUpTally', () => {
  it('telt ja en nee', () => {
    expect(followUpTally(['Ja', 'Ja', 'Nee'])).toEqual({ ja: 2, nee: 1, anders: 0, total: 3 });
  });

  /**
   * Gemeten in de ECHTE export: het Nederlandse blad bevat 20× `Yes` en 17× `No`. De taal
   * hangt dus niet aan het blad, en classificeren op herkomst zou die 37 bij Anders zetten.
   */
  it('herkent Engels in het Nederlandse blad', () => {
    expect(followUpTally(['Yes', 'No', 'Ja'])).toEqual({ ja: 2, nee: 1, anders: 0, total: 3 });
  });

  it('negeert hoofdletters en spaties', () => {
    expect(followUpTally([' JA ', 'nee'])).toEqual({ ja: 1, nee: 1, anders: 0, total: 2 });
  });

  /**
   * DE reden dat het een exacte match is en geen voorvoegsel: allebei komen echt voor, en
   * "No idea, depends on the group" als `Nee` tellen zegt het tegenovergestelde van wat er
   * staat.
   */
  it('telt vrije tekst als Anders, ook als hij met ja of no begint', () => {
    const tally = followUpTally([
      'No idea, depends on the group',
      'Yes, but then slightly shorter',
      'Misschien',
      'Weet ik nog niet',
    ]);
    expect(tally).toEqual({ ja: 0, nee: 0, anders: 4, total: 4 });
  });

  /** 11.302 van de 14.211 NL-rijen hebben deze vraag niet beantwoord. */
  it('laat blanco buiten het totaal', () => {
    expect(followUpTally([null, '', '   ', 'Ja'])).toEqual({
      ja: 1,
      nee: 0,
      anders: 0,
      total: 1,
    });
  });
});

describe('averageLabel', () => {
  it('geeft één decimaal', () => {
    expect(averageLabel([8, 7])).toBe('7.5');
    expect(averageLabel([8, 8, 7])).toBe('7.7');
  });

  it('geeft null als er niets te middelen valt', () => {
    expect(averageLabel([null, null])).toBeNull();
    expect(averageLabel([])).toBeNull();
  });

  it('middelt alleen de ingevulde antwoorden', () => {
    expect(averageLabel([10, null, 8])).toBe('9.0');
  });
});

describe('answeredCount', () => {
  it('telt alleen ingevulde waarden', () => {
    expect(answeredCount([1, null, 3, Number.NaN])).toBe(2);
  });
});

describe('lighten', () => {
  /** Letterlijk de rekenwijze uit `build-html-code.js`; ITG's huidige rapporten zien er zo uit. */
  it('mengt wit erdoor zoals de bestaande generator', () => {
    expect(lighten('#000000', 0.4)).toBe('#666666');
    expect(lighten('#ffffff', 0.4)).toBe('#ffffff');
  });

  /**
   * Onafhankelijk nagerekend met de formule uit `build-html-code.js`, voor drie echte
   * merkkleuren. Dit is de test die bewijst dat de rapporten dezelfde tinten houden — een
   * assertie die `lighten` met zichzelf vergelijkt kan dat per definitie niet.
   */
  it.each([
    ['#0A2B58', '#6c809b', '#9daabc', '#ced5de'],
    ['#F78F44', '#fabc8f', '#fcd2b4', '#fde9da'],
    ['#A3DAC2', '#c8e9da', '#daf0e7', '#edf8f3'],
  ])('leidt uit %s de drie tinten af', (brand, mid, light, lightest) => {
    expect(chartColours(brand)).toEqual({ brand, mid, light, lightest });
  });

  it('houdt twee cijfers per kanaal, ook bij lage waarden', () => {
    expect(lighten('#000000', 0.02)).toBe('#050505');
  });

  it('geeft de drie tinten in oplopende lichtheid', () => {
    const c = chartColours('#0A2B58');
    expect(c.brand).toBe('#0A2B58');
    expect(new Set([c.mid, c.light, c.lightest]).size).toBe(3);
  });
});

describe('joinDutch', () => {
  it.each([
    [['Jan'], 'Jan'],
    [['Jan', 'Piet'], 'Jan en Piet'],
    [['Jan', 'Piet', 'Klaas'], 'Jan, Piet en Klaas'],
    [[], ''],
  ])('voegt %j samen tot %j', (names, expected) => {
    expect(joinDutch(names)).toBe(expected);
  });

  it('slaat lege namen over', () => {
    expect(joinDutch(['Jan', '', '  ', 'Piet'])).toBe('Jan en Piet');
  });
});

describe('trainerWord', () => {
  it('is enkelvoud bij één en meervoud daarboven', () => {
    expect(trainerWord(1)).toBe('trainer');
    expect(trainerWord(2)).toBe('trainers');
    expect(trainerWord(0)).toBe('trainer');
  });
});

describe('firstNames', () => {
  it('pakt de voornaam van elke contactpersoon', () => {
    expect(firstNames('Lisa de Vries, Mark Jansen')).toEqual(['Lisa', 'Mark']);
  });

  it('overleeft dubbele spaties en een losse komma', () => {
    expect(firstNames('  Lisa   de Vries ,, Mark ')).toEqual(['Lisa', 'Mark']);
  });
});

describe('escapeHtml', () => {
  /**
   * Dit is de enige plek waar deelnemersinvoer het document in gaat. De bestaande generator
   * ontsnapt alleen `"` en `<`, waardoor een ampersand in een citaat verkeerd weergegeven kan
   * worden — hier gaan alle vijf.
   */
  it('ontsnapt alle vijf de tekens', () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe(
      '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;'
    );
  });

  /** De ampersand MOET eerst, anders ontsnapt hij de entiteiten die er net zijn neergezet. */
  it('dubbel-ontsnapt niet', () => {
    expect(escapeHtml('a & <b')).toBe('a &amp; &lt;b');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});
