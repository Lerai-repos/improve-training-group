import { describe, expect, it } from 'vitest';

import { rankRecommendations, type Rankable } from '../rank';

function rec(overrides: Partial<Rankable> & { externalItemId: string }): Rankable {
  return {
    totalCostCents: 10000,
    themeAvgScore: 7,
    overallAvgScore: 7,
    trainerTravelCostCents: 0,
    ...overrides,
  };
}

describe('rankRecommendations', () => {
  it('sorts by total cost ascending first', () => {
    const ranked = rankRecommendations([
      rec({ externalItemId: 'b', totalCostCents: 20000 }),
      rec({ externalItemId: 'a', totalCostCents: 10000 }),
    ]);
    expect(ranked.map((r) => r.externalItemId)).toEqual(['a', 'b']);
  });

  it('breaks cost ties by theme average descending, null last', () => {
    const ranked = rankRecommendations([
      rec({ externalItemId: 'lowtheme', themeAvgScore: 6 }),
      rec({ externalItemId: 'notheme', themeAvgScore: null }),
      rec({ externalItemId: 'hightheme', themeAvgScore: 9 }),
    ]);
    expect(ranked.map((r) => r.externalItemId)).toEqual(['hightheme', 'lowtheme', 'notheme']);
  });

  it('then overall average desc, then travel cost asc', () => {
    const ranked = rankRecommendations([
      rec({ externalItemId: 'x', overallAvgScore: 7, trainerTravelCostCents: 500 }),
      rec({ externalItemId: 'y', overallAvgScore: 8, trainerTravelCostCents: 900 }),
      rec({ externalItemId: 'z', overallAvgScore: 7, trainerTravelCostCents: 100 }),
    ]);
    expect(ranked.map((r) => r.externalItemId)).toEqual(['y', 'z', 'x']);
  });

  it('uses external item id as a stable final tie-breaker', () => {
    const ranked = rankRecommendations([
      rec({ externalItemId: '300' }),
      rec({ externalItemId: '100' }),
      rec({ externalItemId: '200' }),
    ]);
    expect(ranked.map((r) => r.externalItemId)).toEqual(['100', '200', '300']);
  });

  it('does not mutate the input array', () => {
    const input = [
      rec({ externalItemId: 'b', totalCostCents: 20000 }),
      rec({ externalItemId: 'a', totalCostCents: 10000 }),
    ];
    const snapshot = input.map((r) => r.externalItemId);
    rankRecommendations(input);
    expect(input.map((r) => r.externalItemId)).toEqual(snapshot);
  });
});
