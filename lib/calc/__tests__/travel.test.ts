import { describe, expect, it } from 'vitest';

import {
  clientTravelCharge,
  trainerTravelCost,
  travelTimeCompensation,
  type TravelTimeConfig,
} from '../travel';

const TRAINER_RATE_CENTS = 23; // €0.23/km
const CLIENT_RATE_CENTS = 45; // €0.45/km

describe('trainerTravelCost / clientTravelCharge', () => {
  it('multiplies round-trip km by the per-km rate, in cents', () => {
    // 40 round-trip km × €0.23 = €9.20
    expect(trainerTravelCost(40, TRAINER_RATE_CENTS)).toBe(920);
    // 40 round-trip km × €0.45 = €18.00
    expect(clientTravelCharge(40, CLIENT_RATE_CENTS)).toBe(1800);
  });

  it('rounds to whole cents', () => {
    // 10.3 km × 23 = 236.9 → 237 cents
    expect(trainerTravelCost(10.3, TRAINER_RATE_CENTS)).toBe(237);
  });
});

describe('travelTimeCompensation', () => {
  const perMinute: TravelTimeConfig = {
    thresholdMinutes: 90,
    mode: 'per_minute',
    feePerMinuteCents: 100, // €1/min (legacy)
  };

  it('pays nothing at or under the threshold', () => {
    expect(travelTimeCompensation(90, perMinute)).toBe(0);
    expect(travelTimeCompensation(45, perMinute)).toBe(0);
  });

  it('pays per minute over the threshold (legacy mode)', () => {
    // (120 - 90) × €1 = €30
    expect(travelTimeCompensation(120, perMinute)).toBe(3000);
  });

  it('supports the hourly-rate mode (open question, config-driven)', () => {
    const hourly: TravelTimeConfig = {
      thresholdMinutes: 90,
      mode: 'hourly_rate',
      feePerMinuteCents: 100,
      hourlyRateCents: 8400, // €84/hr
    };
    // (150 - 90) = 60 min = 1h × €84 = €84
    expect(travelTimeCompensation(150, hourly)).toBe(8400);
  });

  it('throws in hourly-rate mode without an hourly rate', () => {
    const bad: TravelTimeConfig = {
      thresholdMinutes: 90,
      mode: 'hourly_rate',
      feePerMinuteCents: 100,
    };
    expect(() => travelTimeCompensation(150, bad)).toThrow();
  });
});
