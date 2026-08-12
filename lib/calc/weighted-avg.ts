import { round2 } from './rounding';

/** One training's evaluation aggregate, as imported from Google Sheets. */
export interface TrainingEval {
  avgOverallGrade: number | null;
  evaluationCount: number;
}

/** A trainer×theme roll-up, used to compute the trainer's overall average. */
export interface ThemeStat {
  weightedAvg: number | null;
  totalEvaluations: number;
}

/**
 * Whether a training contributes to a theme's average — the ONE predicate behind
 * {@link weightedThemeAvg} and {@link contributingEvaluations}.
 *
 * It exists as a function rather than a repeated condition because the numerator and
 * the denominator have to agree about which rows counted, and a disagreement there is
 * invisible: the average looks right while the count beside it is inflated.
 */
function contributes(e: TrainingEval): boolean {
  return e.avgOverallGrade !== null && !Number.isNaN(e.avgOverallGrade) && e.evaluationCount > 0;
}

/**
 * Weighted trainer×theme average: `Σ(avg × count) / Σ(count)`, to 2 decimals.
 *
 * Only trainings with a non-null grade AND `evaluationCount > 0` contribute.
 * Zero contributing evaluations → **null** (matches legacy flow-5:216-218 — the
 * legacy code returns `null`, NOT `0`, and this distinction is parity-critical).
 */
export function weightedThemeAvg(evals: readonly TrainingEval[]): number | null {
  let totalWeighted = 0;
  let totalEvals = 0;

  for (const e of evals) {
    if (!contributes(e)) {
      continue;
    }
    // `contributes` proved the grade is a number; the non-null assertion is the
    // compiler's, not a new claim.
    totalWeighted += (e.avgOverallGrade ?? 0) * e.evaluationCount;
    totalEvals += e.evaluationCount;
  }

  if (totalEvals === 0) {
    return null;
  }
  return round2(totalWeighted / totalEvals);
}

/**
 * The denominator behind {@link weightedThemeAvg} — the SAME rows, counted.
 *
 * Exposed so no caller has to re-derive "which rows counted". A training with
 * responses but no parseable grade (13 such rows exist in the live NL export)
 * contributes to neither the average nor this count.
 *
 * Invariant, asserted in the tests: this is `0` exactly when `weightedThemeAvg` is
 * `null`.
 */
export function contributingEvaluations(evals: readonly TrainingEval[]): number {
  let total = 0;
  for (const e of evals) {
    if (contributes(e)) {
      total += e.evaluationCount;
    }
  }
  return total;
}

/**
 * Trainer overall average: `Σ(weightedAvg × totalEvaluations) / Σ(totalEvaluations)`
 * across the trainer's theme stats.
 *
 * NOTE the deliberate asymmetry with {@link weightedThemeAvg}: the legacy Airtable
 * Trainers formula returns **0** (not null) when there are no evaluations
 * (`IF({Total Evaluations} > 0, {Sum ScorexEvals} / {Total Evaluations}, 0)`).
 * Full precision is kept — Airtable's precision-1 is display-only and the raw
 * value is what downstream sorting compares.
 */
export function trainerOverallAvg(stats: readonly ThemeStat[]): number {
  let sumScoreXEvals = 0;
  let sumEvals = 0;

  for (const s of stats) {
    if (s.weightedAvg === null || Number.isNaN(s.weightedAvg)) {
      continue;
    }
    if (s.totalEvaluations > 0) {
      sumScoreXEvals += s.weightedAvg * s.totalEvaluations;
      sumEvals += s.totalEvaluations;
    }
  }

  if (sumEvals === 0) {
    return 0;
  }
  return sumScoreXEvals / sumEvals;
}
