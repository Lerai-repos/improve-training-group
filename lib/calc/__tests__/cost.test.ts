import { describe, expect, it } from 'vitest';

import { totalCostCents, trainingFeeCents } from '../cost';

describe('trainingFeeCents', () => {
  it('multiplies billable hours by the hourly rate, in cents', () => {
    // 3.5h × €84 = €294
    expect(trainingFeeCents(3.5, 8400)).toBe(29400);
  });

  it('rounds to whole cents', () => {
    // 2.5h × €88.33 (8833c) = 22082.5 → 22083
    expect(trainingFeeCents(2.5, 8833)).toBe(22083);
  });
});

describe('totalCostCents', () => {
  it('sums fee + trainer travel cost + travel-time compensation', () => {
    expect(
      totalCostCents({
        trainingFeeCents: 29400,
        trainerTravelCostCents: 920,
        travelTimeCompensationCents: 3000,
      })
    ).toBe(33320);
  });

  it('excludes the client travel charge by construction', () => {
    // Only the three trainer-side components are inputs; there is no client field.
    expect(
      totalCostCents({
        trainingFeeCents: 100,
        trainerTravelCostCents: 0,
        travelTimeCompensationCents: 0,
      })
    ).toBe(100);
  });
});
