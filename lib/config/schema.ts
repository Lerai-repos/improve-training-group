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
  mondayApiVersion: z.string().min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
