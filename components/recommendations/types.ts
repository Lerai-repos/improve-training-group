/**
 * The wire shapes, as the browser sees them.
 *
 * Declared here rather than imported from `lib/recommend`: those modules pull in the
 * Upstash client, `node:crypto` and the whole engine, none of which belong in a bundle
 * shipped to a planner's browser. The duplication is deliberate and small, and the
 * contract it mirrors is covered by the route tests.
 */

export interface ViewCapabilities {
  canPlan: boolean;
  canViewFull: boolean;
}

export interface RowTheme {
  themeItemId: string;
  qualification: 'green' | 'red' | null;
  average: number | null;
  evaluationCount: number | null;
  timesTaught: number | null;
}

/** The restricted shape; every field here is present for every caller. */
export interface BaseRow {
  trainerItemId: string;
  rank: number;
  roundTripDurationMinutes: number;
  approached: boolean;
}

/** What a `full` caller additionally receives. All optional — a restricted row has none. */
export interface Row extends BaseRow {
  themes?: RowTheme[];
  themeAvgScore?: number | null;
  /** Null means "no grades", NOT a zero. The two must never render alike. */
  overallAverageDisplay?: number | null;
  overallEvaluationCount?: number | null;
  hourlyRateCents?: number;
  billableHours?: number;
  trainingFeeCents?: number;
  trainerTravelCostCents?: number;
  travelTimeCompensationCents?: number;
  clientTravelChargeCents?: number;
  totalCostCents?: number;
  /** Legacy "Opdrachten deze maand / dit jaar" — the month/year of THIS training. */
  assignmentsThisMonth?: number | null;
  assignmentsThisYear?: number | null;
}

export type ViewState =
  | { kind: 'idle' }
  | { kind: 'computing'; generation: number }
  | { kind: 'ready'; generation: number; rows: Row[]; duurTraining?: number | null }
  | { kind: 'no_match'; generation: number }
  | { kind: 'failed'; generation: number; stage: string }
  | { kind: 'unavailable'; generation: number; label: string };

export interface RecommendationView {
  state: ViewState;
  caps: ViewCapabilities;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** The generation a state belongs to, or null for `idle`. */
export function generationOf(state: ViewState): number | null {
  return state.kind === 'idle' ? null : state.generation;
}
