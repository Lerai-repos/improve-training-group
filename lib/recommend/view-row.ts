import { z } from 'zod';

import type { EffectiveQualification } from '@lib/monday/qualification';

import type { EffectiveQual, RankedRecommendation } from './types';

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
  themeExternalIds: readonly string[]
): StoredRow[] {
  const byTrainer = new Map<string, Map<string, EffectiveQual>>();
  for (const q of effective) {
    const themes = byTrainer.get(q.trainerExternalId) ?? new Map<string, EffectiveQual>();
    themes.set(q.themaExternalId, q);
    byTrainer.set(q.trainerExternalId, themes);
  }

  return ranked.map((r) => {
    const themes = byTrainer.get(r.externalItemId);
    return {
      trainerItemId: r.externalItemId,
      rank: r.rank,
      themes: themeExternalIds.map((themeItemId) => ({
        themeItemId,
        // Absent from the matrix = never assessed for this theme, which reads as
        // "geen oordeel" rather than a negative one.
        qualification: themes?.get(themeItemId)?.effective ?? null,
        // Evaluations are inert until M3; null keeps "no data" distinct from a zero.
        average: null,
        evaluationCount: null,
        timesTaught: null,
      })),
      themeAvgScore: r.themeAvgScore,
      overallAvgScore: r.overallAvgScore,
      // Both null while evaluations are inert. Once M3 lands, the display value stays
      // null whenever the count is 0 — that is the case the scalar cannot express.
      overallAverageDisplay: null,
      overallEvaluationCount: null,
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
