import { describe, expect, it } from 'vitest';

import {
  billableHours,
  rankRecommendations,
  totalCostCents,
  trainerTravelCost,
  trainingFeeCents,
  travelTimeCompensation,
  weightedThemeAvg,
} from '@lib/calc';

/**
 * PARITY HARNESS.
 *
 * These are hand-computed REPRESENTATIVE fixtures that exercise the full calc
 * chain end-to-end, to unblock development. They are NOT the completion gate.
 *
 * The M1 completion gate is a separate suite of 20-30 REAL anonymized Airtable
 * snapshots (zero-eval, multi-trainer/theme, missing scores, variable-rate,
 * no-travel), asserting the engine matches legacy output to 2 decimals. That
 * export can be pulled now (Airtable is live) and dropped in here. Until it
 * passes, M1 is not "done" — see the plan.
 */
describe('parity — representative fixtures (dev unblock, not the gate)', () => {
  it('scores a 3h @ €84 session with travel, matching legacy components', () => {
    const hours = billableHours(3); // short-session floor → 3.5
    const fee = trainingFeeCents(hours, 8400); // 3.5 × €84 = €294.00
    const trainerTravel = trainerTravelCost(40, 23); // 40km × €0.23 = €9.20
    const timeComp = travelTimeCompensation(120, {
      thresholdMinutes: 90,
      mode: 'per_minute',
      feePerMinuteCents: 100,
    }); // (120-90) × €1 = €30.00
    const total = totalCostCents({
      trainingFeeCents: fee,
      trainerTravelCostCents: trainerTravel,
      travelTimeCompensationCents: timeComp,
    });

    expect(hours).toBe(3.5);
    expect(fee).toBe(29400);
    expect(trainerTravel).toBe(920);
    expect(timeComp).toBe(3000);
    expect(total).toBe(33320); // €333.20
  });

  it('reproduces weighted-average rounding and zero-eval null semantics', () => {
    expect(
      weightedThemeAvg([
        { avgOverallGrade: 8, evaluationCount: 10 },
        { avgOverallGrade: 6, evaluationCount: 2 },
      ])
    ).toBe(7.67);
    expect(weightedThemeAvg([])).toBeNull();
  });

  it('ranks a mixed set in the legacy 4-layer order', () => {
    const ranked = rankRecommendations([
      {
        externalItemId: 'B',
        totalCostCents: 30000,
        themeAvgScore: 9,
        overallAvgScore: 8,
        trainerTravelCostCents: 500,
      },
      {
        externalItemId: 'A',
        totalCostCents: 30000,
        themeAvgScore: 9,
        overallAvgScore: 8,
        trainerTravelCostCents: 500,
      },
      {
        externalItemId: 'C',
        totalCostCents: 25000,
        themeAvgScore: 6,
        overallAvgScore: 7,
        trainerTravelCostCents: 100,
      },
    ]);
    // Cheapest first (C); then A before B on the stable id tie-breaker.
    expect(ranked.map((r) => r.externalItemId)).toEqual(['C', 'A', 'B']);
  });
});
