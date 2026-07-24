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
  // NOTE: the pinned Monday API version is NOT config here — it lives in
  // board-config `MONDAY_API_VERSION` (a code constant, the single source of
  // truth). Dry-run is DB-free, so the version can't come from the DB anyway.
});

export type AppConfig = z.infer<typeof appConfigSchema>;
