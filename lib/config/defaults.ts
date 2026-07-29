import { recommendableGroups } from '@lib/monday/board-config';

import type { AppConfig } from './schema';

/**
 * Fallback config defaults — the known fase-1 values.
 *
 * These are used when a key is absent from the DB. In PRODUCTION, financial keys
 * (travel rates + travel-time fee) must be present in the DB; a missing one is an
 * error, not silently defaulted. See `buildAppConfig`.
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
