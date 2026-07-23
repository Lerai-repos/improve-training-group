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
    if (e.avgOverallGrade === null || Number.isNaN(e.avgOverallGrade)) {
      continue;
    }
    if (e.evaluationCount > 0) {
      totalWeighted += e.avgOverallGrade * e.evaluationCount;
      totalEvals += e.evaluationCount;
    }
  }

  if (totalEvals === 0) {
    return null;
  }
  return round2(totalWeighted / totalEvals);
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
