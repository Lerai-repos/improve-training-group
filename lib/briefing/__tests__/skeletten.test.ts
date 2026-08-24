import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ORGANISATIE_TOKEN } from '../concept';

/**
 * Bewaakt de uitvoer van `tools/skeletten/extract.py`, want die is de bron voor wat er in
 * Monday komt te staan en dus voor wat een trainer leest.
 *
 * De brontekst van ITG staat vol met opmaakresidu — losse `xx`-alinea's rond het variabele
 * stuk, zinnen die midden in tweeën gebroken zijn, een enkele losse letter. Als dat er ooit
 * weer in sluipt komt het als bullet in een briefing bij de klant terecht.
 */
interface Skeleton {
  readonly skelet: string;
  readonly regels: readonly string[];
}

interface ThemaMap {
  readonly kaart: Readonly<Record<string, string>>;
  readonly geenThema: Readonly<Record<string, string>>;
  readonly openVraag: Readonly<Record<string, string>>;
}

const skeletons = JSON.parse(
  readFileSync('tools/skeletten/skeletten.json', 'utf-8')
) as Skeleton[];
const map = JSON.parse(readFileSync('tools/skeletten/thema-map.json', 'utf-8')) as ThemaMap;

/** Gemeten in het bronbestand: 85 koppen, waarvan 37 de afsprakenbullet hebben. */
const EXPECTED_THEMES = 85;
const EXPECTED_AFSPRAKEN = 37;
/** De kortste échte regel is 25 tekens; alles daaronder is residu. */
const MIN_LINE = 20;

describe('de uitgelezen skeletten', () => {
  it('bevat alle 85 thema\'s', () => {
    expect(skeletons).toHaveLength(EXPECTED_THEMES);
  });

  it('heeft `Fail forward` als eigen thema en niet verstopt in het pensioenthema', () => {
    const namen = skeletons.map((s) => s.skelet);
    expect(namen).toContain('Fail forward');
    expect(namen).toContain('Training Wat te doen bij je pensioen');
  });

  it('heeft geen `xx`-markeringen meer laten staan', () => {
    const rest = skeletons.flatMap((s) =>
      s.regels.filter((r) => /(?<![A-Za-z0-9])[xX]{1,3}(?![A-Za-z0-9])/.test(r))
    );
    expect(rest).toEqual([]);
  });

  it('kent nog maar één schrijfwijze van de plaatshouder', () => {
    const woord = skeletons.flatMap((s) =>
      s.regels.filter((r) => /organisatienaam/i.test(r))
    );
    expect(woord).toEqual([]);
    const dubbel = skeletons.flatMap((s) =>
      s.regels.filter((r) => r.split(ORGANISATIE_TOKEN).length > 2)
    );
    expect(dubbel).toEqual([]);
  });

  it('heeft geen afgebroken of losse regels', () => {
    const stukjes = skeletons.flatMap((s) =>
      s.regels.filter((r) => r.length < MIN_LINE).map((r) => `${s.skelet}: ${r}`)
    );
    expect(stukjes).toEqual([]);
  });

  /**
   * Besloten 21-Aug-2026: de afsprakenbullet blijft staan bij de thema's die hem nu hebben
   * en komt er niet bij de andere bij. Dat is een keuze per thema, geen vraag per briefing.
   */
  it('houdt de afsprakenbullet bij precies de 37 thema\'s die hem hadden', () => {
    const met = skeletons.filter((s) =>
      s.regels.some((r) => r.startsWith('Welke afspraken en verbeteringen'))
    );
    expect(met).toHaveLength(EXPECTED_AFSPRAKEN);
  });

  /** Interne verkoopinstructie; die zou anders letterlijk bij de trainer belanden. */
  it('laat de salesnotitie uit `Kennismaken met AI` weg', () => {
    const ai = skeletons.find((s) => s.skelet === 'Kennismaken met AI');
    expect(ai).toBeDefined();
    expect(ai?.regels.some((r) => r.includes('salesgesprek'))).toBe(false);
  });

  it('houdt het blok "Wat er niet aan bod komt" bij `Omgaan met agressie`', () => {
    const agressie = skeletons.find((s) => s.skelet === 'Omgaan met agressie');
    expect(agressie?.regels.some((r) => r.startsWith('Wat er niet aan bod komt'))).toBe(true);
  });
});

describe('de kaart naar het Themas-bord', () => {
  it('deelt elk skelet in, precies één keer', () => {
    for (const { skelet } of skeletons) {
      const buckets = [map.kaart, map.geenThema, map.openVraag].filter(
        (b) => b[skelet] !== undefined
      );
      expect(buckets.length, `${skelet} staat in ${buckets.length} bakjes`).toBeLessThanOrEqual(1);
    }
  });

  it('verwijst nergens naar een skelet dat niet bestaat', () => {
    const namen = new Set(skeletons.map((s) => s.skelet));
    const onbekend = [...Object.keys(map.kaart), ...Object.keys(map.geenThema), ...Object.keys(map.openVraag)]
      .filter((k) => !namen.has(k));
    expect(onbekend).toEqual([]);
  });

  /**
   * Twee skeletten naar hetzelfde thema is precies de botsing waar de openstaande vragen
   * over gaan; in de vastgelegde kaart mag hij niet voorkomen, want dan wint stilzwijgend
   * degene die het laatst geschreven wordt.
   */
  it('stuurt nooit twee skeletten naar hetzelfde thema', () => {
    const doelen = Object.values(map.kaart);
    expect(new Set(doelen).size).toBe(doelen.length);
  });
});
