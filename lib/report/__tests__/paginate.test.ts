import { describe, expect, it } from 'vitest';

import { planPages } from '../paginate';

import type { Block } from '../paginate';

const titel = (height: number): Block => ({ kind: 'title', height });
const item = (height: number): Block => ({ kind: 'item', height });

/** Hoeveel er op één pagina past, in dezelfde eenheid als de blokken. */
const PAGINA = 100;

describe('planPages', () => {
  it('zet alles op één pagina als het past', () => {
    expect(planPages([titel(20), item(20), item(20)], PAGINA)).toEqual([[0, 1, 2]]);
  });

  it('breekt af zodra een blok er niet meer bij past', () => {
    expect(planPages([titel(20), item(50), item(50)], PAGINA)).toEqual([[0, 1], [2]]);
  });

  it('vult een pagina precies tot de rand zonder er een af te breken', () => {
    expect(planPages([item(50), item(50)], PAGINA)).toEqual([[0, 1]]);
  });

  it('laat geen enkel blok weg', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => item(10 + (i % 7)));
    const plan = planPages(blocks, PAGINA);
    expect(plan.flat()).toEqual(blocks.map((_, i) => i));
  });

  it('maakt geen lege paginas', () => {
    const blocks = Array.from({ length: 25 }, () => item(33));
    expect(planPages(blocks, PAGINA).every((p) => p.length > 0)).toBe(true);
  });

  it('geeft niets terug voor niets', () => {
    expect(planPages([], PAGINA)).toEqual([]);
  });
});

/**
 * Een vraag onderaan een pagina met de antwoorden op de volgende leest als een vraag zonder
 * antwoord. Dit is `page-break-after: avoid`, die wij zelf moeten uitvoeren omdat wij de
 * pagina's maken en Chromium niet.
 */
describe('een kop blijft bij zijn eerste antwoord', () => {
  it('schuift een kop door die anders als laatste op de pagina staat', () => {
    // De kop past nog net, het eerste citaat erna niet meer.
    const plan = planPages([item(70), titel(20), item(30)], PAGINA);
    expect(plan).toEqual([[0], [1, 2]]);
  });

  it('laat een kop staan als er nog een citaat bij past', () => {
    const plan = planPages([item(50), titel(20), item(20)], PAGINA);
    expect(plan).toEqual([[0, 1, 2]]);
  });

  it('schuift een kop zonder enig citaat erna niet eindeloos door', () => {
    const plan = planPages([item(70), titel(20)], PAGINA);
    expect(plan.flat()).toEqual([0, 1]);
    expect(plan).toHaveLength(2);
  });
});

/**
 * Een citaat weggooien omdat het niet past is precies wat de citatensecties nooit mogen doen;
 * dat was een expliciete reparatie op de oude generator.
 */
describe('een blok dat op geen enkele pagina past', () => {
  it('krijgt tóch een pagina in plaats van te verdwijnen', () => {
    const plan = planPages([item(20), item(500), item(20)], PAGINA);
    expect(plan.flat()).toEqual([0, 1, 2]);
  });

  it('staat alleen op zijn eigen pagina', () => {
    const plan = planPages([item(20), item(500), item(20)], PAGINA);
    const reus = plan.find((p) => p.includes(1));
    expect(reus).toEqual([1]);
  });
});
