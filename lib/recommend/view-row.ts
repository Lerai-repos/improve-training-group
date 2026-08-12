import { z } from 'zod';

import type { EffectiveQualification } from '@lib/monday/qualification';

import type { EffectiveQual, RankedRecommendation, TrainerThemeStat } from './types';

/**
 * The recommendation list as it is persisted for the item view.
 *
 * Two rules shape this type, and both exist because getting them wrong is invisible:
 *
 * 1. **No names, ever.** Only Monday item ids and numbers are stored, so a breach of
 *    the key/value store yields opaque identifiers. The view resolves trainer names
 *    live through the Monday session, the same discipline `travel-cache.ts` follows by
 *    storing keyed address fingerprints instead of addresses.
 * 2. **"No grades" is not "bad grades".** `trainerOverallAvg` deliberately returns 0
 *    rather than null when a trainer has no evaluations (the legacy Airtable formula —
 *    see `weighted-avg.ts`). That scalar is fine for sorting and catastrophic on
 *    screen: a newly qualified trainer would read as the worst in the list. So the
 *    ranking scalar and the display value are separate fields, and only the display
 *    one may be rendered.
 */

/**
 * These are schemas first and types second, because the rows make a round trip through
 * Redis: what comes back is `unknown` until something checks it. Declaring the shape
 * twice — an interface plus a validator — is how the two drift apart, and a validator
 * that has drifted is worse than none, so `StoredRow` is inferred from its schema.
 *
 * The annotation on {@link qualificationSchema} is the one drift guard that cannot be
 * inferred: it makes the compiler check these literals still match
 * {@link EffectiveQualification}, so adding a third qualification upstream breaks the
 * build here instead of silently rejecting every stored row at read time.
 */
const qualificationSchema: z.ZodType<EffectiveQualification> = z.union([
  z.literal('green'),
  z.literal('red'),
]);

/**
 * Money is integer, non-negative cents — the calc layer's contract, not a guess:
 * every figure that reaches here is `Math.round()`ed (`cost.ts`, `travel.ts`) over
 * non-negative distances and rates, and the cohort rates are integer constants.
 * Widening this to `finite()` would let malformed remuneration data — `84.5`, `-100` —
 * through the one gate that exists to catch it. Should a fractional pricing model ever
 * arrive, that is a deliberate change to how money is represented, and it should break
 * here rather than round somewhere invisible.
 */
const moneySchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();

/** Per-theme detail. A multi-theme training otherwise hides which theme a number is for. */
export const storedRowThemeSchema = z.object({
  themeItemId: z.string().min(1),
  /** null = not assessed (grijs / absent), which is NOT the same as red. */
  qualification: qualificationSchema.nullable(),
  /** null until M3 populates evaluations; null ≠ 0. */
  average: z.number().finite().nullable(),
  evaluationCount: countSchema.nullable(),
  timesTaught: countSchema.nullable(),
});

export const storedRowSchema = z.object({
  trainerItemId: z.string().min(1),
  rank: z.number().int().positive(),
  themes: z.array(storedRowThemeSchema),
  /** Weighted average over THIS training's themes; null when there is no data. */
  themeAvgScore: z.number().finite().nullable(),
  /**
   * RANKING ONLY — never serialize to a client. 0 means "no evaluations", not "bad".
   * `toFullRow`/`toRestrictedRow` drop it; that is the whole reason they exist.
   */
  overallAvgScore: z.number().finite(),
  /** What the UI may show: null when there is nothing to average. */
  overallAverageDisplay: z.number().finite().nullable(),
  overallEvaluationCount: countSchema.nullable(),
  hourlyRateCents: moneySchema,
  // Not integers, and deliberately so: a training can be 3.5 hours, and a round trip is
  // the Routes API's seconds ÷ 60 (`travel.ts`). Only the cents are whole.
  billableHours: z.number().finite().nonnegative(),
  trainingFeeCents: moneySchema,
  trainerTravelCostCents: moneySchema,
  roundTripDurationMinutes: z.number().finite().nonnegative(),
  travelTimeCompensationCents: moneySchema,
  clientTravelChargeCents: moneySchema,
  totalCostCents: moneySchema,
});

/**
 * Workload — legacy's "Opdrachten deze maand / dit jaar" — is deliberately NOT here.
 *
 * It is volatile: linking a trainer to a DIFFERENT Agenda item changes their load without
 * touching this training's generation, so a count frozen into this row would keep being
 * served, and sorted on, for up to twelve months with nothing to mark it stale. Immutable
 * artifacts may only hold what was true at compute time and stays true.
 *
 * It is resolved at read time instead, from a short-lived shared index — see
 * `assignment-cache.ts` and `toFullRow`.
 */

export type StoredRowTheme = z.infer<typeof storedRowThemeSchema>;
export type StoredRow = z.infer<typeof storedRowSchema>;

/**
 * Build the persisted rows from a completed run.
 *
 * `effective` is the whole training's qualification matrix; each row keeps only its own
 * trainer's entries, in the training's theme order so the columns line up across rows.
 */
export function toStoredRows(
  ranked: readonly RankedRecommendation[],
  effective: readonly EffectiveQual[],
  themeExternalIds: readonly string[],
  evaluations: readonly TrainerThemeStat[] | null
): StoredRow[] {
  const byTrainer = new Map<string, Map<string, EffectiveQual>>();
  for (const q of effective) {
    const themes = byTrainer.get(q.trainerExternalId) ?? new Map<string, EffectiveQual>();
    themes.set(q.themaExternalId, q);
    byTrainer.set(q.trainerExternalId, themes);
  }

  /** `null` = the statistics were not consulted; see `ServiceDeps.evaluations`. */
  const consulted = evaluations !== null;
  const statsByTrainer = new Map<string, Map<string, TrainerThemeStat>>();
  for (const stat of evaluations ?? []) {
    const themes = statsByTrainer.get(stat.trainerExternalId) ?? new Map<string, TrainerThemeStat>();
    themes.set(stat.themaExternalId, stat);
    statsByTrainer.set(stat.trainerExternalId, themes);
  }

  return ranked.map((r) => {
    const themes = byTrainer.get(r.externalItemId);
    const stats = statsByTrainer.get(r.externalItemId);
    const mine = [...(stats?.values() ?? [])];
    const overallCount = mine.reduce((sum, stat) => sum + stat.evaluationCount, 0);
    return {
      trainerItemId: r.externalItemId,
      rank: r.rank,
      themes: themeExternalIds.map((themeItemId) => ({
        themeItemId,
        // Absent from the matrix = never assessed for this theme, which reads as
        // "geen oordeel" rather than a negative one.
        qualification: themes?.get(themeItemId)?.effective ?? null,
        average: stats?.get(themeItemId)?.avgOverallGrade ?? null,
        /**
         * `0`, not `null`, for an absent pair — and that is the whole feature.
         *
         * With a successful read, absence is a FACT: this trainer has never taught this
         * theme and has never been evaluated on it. `null` means "the source could not
         * tell us", which the throwing read contract makes unreachable. Mapping absence
         * to `null` here would render `—` and keep "groen maar nooit gegeven"
         * indistinguishable from "no data" — the exact confusion this feature exists to
         * end (`02-datamodel-monday.md:121`).
         */
        evaluationCount: stats?.get(themeItemId)?.evaluationCount ?? (consulted ? 0 : null),
        timesTaught: stats?.get(themeItemId)?.timesTaught ?? (consulted ? 0 : null),
      })),
      themeAvgScore: r.themeAvgScore,
      overallAvgScore: r.overallAvgScore,
      /**
       * The display pair, distinct from `overallAvgScore` by exactly one asymmetry:
       * `trainerOverallAvg` returns 0 for a trainer with no evaluations (legacy's rule,
       * correct for sorting) where the screen must say "geen cijfers". Same number
       * whenever the count is non-zero.
       */
      overallAverageDisplay: overallCount === 0 ? null : r.overallAvgScore,
      overallEvaluationCount: consulted ? overallCount : null,
      hourlyRateCents: r.hourlyRateCents,
      billableHours: r.billableHours,
      trainingFeeCents: r.trainingFeeCents,
      trainerTravelCostCents: r.trainerTravelCostCents,
      roundTripDurationMinutes: r.roundTripDurationMinutes,
      travelTimeCompensationCents: r.travelTimeCompensationCents,
      clientTravelChargeCents: r.clientTravelChargeCents,
      totalCostCents: r.totalCostCents,
    };
  });
}
