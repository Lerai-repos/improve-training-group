import type { StoredRow } from '../view-row';

/**
 * A complete {@link StoredRow}, so tests that only care about one field still build a
 * real one. The alternative — casting a partial object — would let a future field be
 * added without any test noticing it was never populated.
 */
export function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    trainerItemId: 't1',
    rank: 1,
    themes: [
      {
        themeItemId: 'th1',
        qualification: 'green',
        average: null,
        evaluationCount: null,
        timesTaught: null,
      },
    ],
    themeAvgScore: null,
    overallAvgScore: 0,
    overallAverageDisplay: null,
    overallEvaluationCount: null,
    hourlyRateCents: 8_400,
    billableHours: 4,
    trainingFeeCents: 33_600,
    trainerTravelCostCents: 1_500,
    roundTripDurationMinutes: 52,
    travelTimeCompensationCents: 0,
    clientTravelChargeCents: 900,
    totalCostCents: 35_100,
    ...overrides,
  };
}
