import type { TrainerTravel } from './types';

/** A one-way Routes leg (raw provider output; km + minutes, before doubling). */
export interface OneWayLeg {
  distanceKm: number;
  durationMinutes: number;
}

/**
 * The SINGLE one-way → round-trip doubling point. The Routes API returns one-way
 * distance/time; every downstream calc consumes round-trip values
 * ({@link TrainerTravel}), so the ×2 happens here exactly once (never in the calc
 * layer — see `lib/calc/types.ts`).
 */
export function toTrainerTravel(trainerLeg: OneWayLeg, hqLeg: OneWayLeg): TrainerTravel {
  return {
    roundTripDistanceKm: trainerLeg.distanceKm * 2,
    hqRoundTripDistanceKm: hqLeg.distanceKm * 2,
    roundTripDurationMinutes: trainerLeg.durationMinutes * 2,
  };
}
