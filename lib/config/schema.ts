import { z } from 'zod';

/**
 * Typed, validated application config. Non-financial operational settings only —
 * hourly rates live in `rate_cards` (effective-dated), never here.
 */
export const appConfigSchema = z.object({
  hqAddress: z.string().min(1),
  evaluationThresholdHours: z.number().positive(),
  travelRateTrainerCentsPerKm: z.number().int().nonnegative(),
  travelRateClientCentsPerKm: z.number().int().nonnegative(),
  travelTimeThresholdMinutes: z.number().int().nonnegative(),
  travelTimeMode: z.enum(['per_minute', 'hourly_rate']),
  travelTimeFeePerMinuteCents: z.number().int().nonnegative(),
  // Which Monday trainer-board groups count toward recommendations. Configurable
  // (fase-2a: "selecteerbare trainergroepen"), NOT hardcoded. The min(1) is
  // deliberate: an empty selection would make every training return GEEN MATCH —
  // a legitimate-looking answer that is really a config error, so it fails loudly.
  // (`.min(1)` rather than `.nonempty()` so the inferred type stays `string[]`.)
  recommendableTrainerGroups: z
    .array(z.string().min(1))
    .min(1, 'RECOMMENDABLE_TRAINER_GROUPS must list at least one group'),
  // NOTE: the pinned Monday API version is NOT config here — it lives in
  // board-config `MONDAY_API_VERSION` (a code constant, the single source of
  // truth). Dry-run is DB-free, so the version can't come from the DB anyway.
});

export type AppConfig = z.infer<typeof appConfigSchema>;
