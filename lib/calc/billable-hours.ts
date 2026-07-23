/** Sessions at or above this length bill their actual duration. */
const FULL_DAY_THRESHOLD_HOURS = 4;

/**
 * Billable hours ("Duur facturatie").
 *
 * A session shorter than 4h bills a floored-up amount so short sessions still
 * cover setup/travel overhead: `((4 - duur) / 2) + duur`. 4h and longer bill the
 * actual duration. Zero/negative durations pass through unchanged.
 *
 * Verified against Airtable formula `fld5aINAgsl1lg2N3` (airtable.md:49) and the
 * n8n implementation (flow-6:674). Kevin confirmed 13 Jul: 2h→3, 3h→3.5.
 */
export function billableHours(duur: number): number {
  if (duur > 0 && duur < FULL_DAY_THRESHOLD_HOURS) {
    return (FULL_DAY_THRESHOLD_HOURS - duur) / 2 + duur;
  }
  return duur;
}
