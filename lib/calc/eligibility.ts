/**
 * Whether a training's duration qualifies it for evaluation.
 * Matches Airtable `Telt voor evaluatie`: `Duur training >= Uren threshold`
 * (airtable.md:52 — note `>=`, inclusive).
 */
export function countsForEvaluation(duurTraining: number, thresholdHours: number): boolean {
  return duurTraining >= thresholdHours;
}
