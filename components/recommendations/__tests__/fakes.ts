import type { RecommendationsApi } from '../api';
import type { MondayBridge, MondayContext } from '../monday-client';
import type { RecommendationView, Row } from '../types';

/**
 * Stand-ins for the two things a test cannot have: a Monday iframe and our backend.
 *
 * Both are the real interfaces, so a change to either breaks these at compile time
 * rather than leaving the tests asserting a shape nothing produces any more.
 */

export function fakeMonday(
  initial: MondayContext = { itemId: '111', boardId: '5087396949', theme: 'light' }
): MondayBridge & {
  /** Simulate the planner clicking a different item without the iframe remounting. */
  changeContext: (context: MondayContext) => void;
  tokens: string[];
  apiCalls: number;
} {
  const listeners: Array<(context: MondayContext) => void> = [];
  const tokens: string[] = [];
  let issued = 0;
  let apiCalls = 0;

  const bridge = {
    context: () => Promise.resolve(initial),
    onContextChange(listener: (context: MondayContext) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    sessionToken() {
      issued += 1;
      const token = `token-${issued}`;
      tokens.push(token);
      return Promise.resolve(token);
    },
    api(): Promise<unknown> {
      apiCalls += 1;
      return Promise.resolve({ items: [{ id: '900', name: 'Sanne de Vries' }] });
    },
    changeContext(context: MondayContext) {
      for (const listener of [...listeners]) {
        listener(context);
      }
    },
    get tokens() {
      return tokens;
    },
    get apiCalls() {
      return apiCalls;
    },
  };

  return bridge;
}

export function row(overrides: Partial<Row> = {}): Row {
  return {
    trainerItemId: '900',
    rank: 1,
    roundTripDurationMinutes: 52,
    approached: false,
    overallAverageDisplay: null,
    overallEvaluationCount: 0,
    hourlyRateCents: 8_400,
    billableHours: 4,
    trainingFeeCents: 33_600,
    trainerTravelCostCents: 1_500,
    travelTimeCompensationCents: 0,
    clientTravelChargeCents: 900,
    totalCostCents: 35_100,
    themes: [],
    themeAvgScore: null,
    assignmentsThisMonth: 0,
    assignmentsThisYear: 0,
    ...overrides,
  };
}

/** The restricted payload: the same row with every monetary field absent. */
export function restrictedRow(overrides: Partial<Row> = {}): Row {
  return {
    trainerItemId: '900',
    rank: 1,
    roundTripDurationMinutes: 52,
    approached: false,
    ...overrides,
  };
}

export const readyView = (rows: Row[], canViewFull = true, canPlan = true): RecommendationView => ({
  state: { kind: 'ready', generation: 1, rows },
  caps: { canPlan, canViewFull },
});

export function fakeApi(
  responses: RecommendationView[]
): RecommendationsApi & { gets: number; recalculates: string[]; approached: unknown[] } {
  let gets = 0;
  const recalculates: string[] = [];
  const approached: unknown[] = [];

  return {
    get() {
      const view = responses[Math.min(gets, responses.length - 1)];
      gets += 1;
      return Promise.resolve(view);
    },
    recalculate(_itemId: string, actionId: string) {
      recalculates.push(actionId);
      return Promise.resolve();
    },
    setApproached(_itemId, input) {
      approached.push(input);
      return Promise.resolve();
    },
    get gets() {
      return gets;
    },
    get recalculates() {
      return recalculates;
    },
    get approached() {
      return approached;
    },
  };
}
