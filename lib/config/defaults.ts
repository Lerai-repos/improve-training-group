import { recommendableGroups } from '@lib/monday/board-config';

import type { AppConfig } from './schema';

/**
 * Fallback config defaults — the known fase-1 values.
 *
 * ⚠️ **Unreachable in production since the Instellingen cutover.** These are used when
 * a key is absent, which used to mean "nobody set the variable" and now would mean
 * "somebody deleted the board row" — a mistake, not an opinion. `lib/settings/required.ts`
 * asserts every board-owned key is PRESENT before `buildAppConfig` ever sees the rows,
 * so a deleted `HQ ADRES` fails loudly instead of silently restoring the address below.
 *
 * What still uses them: `replay-verify` and explicitly-offline scripts, which must stay
 * hermetic, and `TRAVEL_TIME_MODE` / `THRESHOLD_HOURS`, which are deliberately kept off
 * the board and injected from the environment instead.
 *
 * The travel-time settings encode the LEGACY behavior (per-minute, €1/min). The
 * mode is config-driven because the correct formula is an open question with the
 * client — do not hard-code the alternative.
 */
export const CONFIG_DEFAULTS: AppConfig = {
  hqAddress: 'Wolvenplein 25, Utrecht',
  evaluationThresholdHours: 4,
  travelRateTrainerCentsPerKm: 23,
  travelRateClientCentsPerKm: 45,
  travelTimeThresholdMinutes: 90,
  travelTimeMode: 'per_minute',
  travelTimeFeePerMinuteCents: 100,
  // Seeded from GROUP_POLICY so "the groups we shipped with" has ONE source of
  // truth; the DB row takes over once set.
  recommendableTrainerGroups: recommendableGroups(),
};
