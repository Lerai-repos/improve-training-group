import {
  contributingEvaluations,
  trainerOverallAvg,
  weightedThemeAvg,
  type ThemeStat,
  type TrainingEval,
} from '@lib/calc';

import type { TrainerScores, TrainerThemeEval } from './types';

/**
 * Compute a trainer's ranking scores from eval-snapshot rows.
 *
 * - `themeAvgScore` = the trainer's weighted average over the TRAINING's themes
 *   (null when there is no eval data — sorts last).
 * - `overallAvgScore` = the trainer's overall weighted average across ALL their
 *   themes (0 when none — the deliberate legacy asymmetry, see weighted-avg.ts).
 *
 * These are inert until M3 populates `trainings.*_snapshot`; today every input row
 * is absent, so scores are (null, 0) and ranking falls back to cost↑ then travel↑.
 */
export function computeScores(
  trainerExternalId: string,
  trainingThemeExternalIds: readonly string[],
  evals: readonly TrainerThemeEval[]
): TrainerScores {
  const mine = evals.filter((e) => e.trainerExternalId === trainerExternalId);
  const trainingThemes = new Set(trainingThemeExternalIds);

  // themeAvgScore: weighted over just the training's themes.
  const themeEvals: TrainingEval[] = mine
    .filter((e) => trainingThemes.has(e.themaExternalId))
    .map((e) => ({ avgOverallGrade: e.avgOverallGrade, evaluationCount: e.evaluationCount }));

  // overallAvgScore: one ThemeStat per theme (across ALL the trainer's themes).
  const byTheme = new Map<string, TrainingEval[]>();
  for (const e of mine) {
    const list = byTheme.get(e.themaExternalId) ?? [];
    list.push({ avgOverallGrade: e.avgOverallGrade, evaluationCount: e.evaluationCount });
    byTheme.set(e.themaExternalId, list);
  }
  // `contributingEvaluations`, not a raw sum: the weight a theme carries here must be
  // the evaluations that actually produced its average. Summing every row lets a theme
  // with one graded and one ungraded training claim the ungraded one's responses as
  // backing for a score they never fed.
  const stats: ThemeStat[] = [...byTheme.values()].map((themeEvalsForTheme) => ({
    weightedAvg: weightedThemeAvg(themeEvalsForTheme),
    totalEvaluations: contributingEvaluations(themeEvalsForTheme),
  }));

  return {
    themeAvgScore: weightedThemeAvg(themeEvals),
    overallAvgScore: trainerOverallAvg(stats),
  };
}
