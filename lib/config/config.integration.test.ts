import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '@lib/testing/supabase-clients';

import { clearConfigCache, getAppConfig } from './config';

const admin = adminClient();
const RATE_KEY = 'TRAVEL_RATE_TRAINER_CENTS_PER_KM';

async function setConfig(key: string, value: string): Promise<void> {
  const { error } = await admin.from('config').update({ value }).eq('key', key);
  if (error) {
    throw new Error(error.message);
  }
}

describe('config layer (against live DB)', () => {
  beforeEach(() => {
    clearConfigCache();
  });
  afterAll(async () => {
    await setConfig(RATE_KEY, '23'); // restore seeded value
    clearConfigCache();
  });

  it('reads and validates seeded config values', async () => {
    const cfg = await getAppConfig(admin);
    expect(cfg.travelRateTrainerCentsPerKm).toBe(23);
    expect(cfg.travelRateClientCentsPerKm).toBe(45);
    expect(cfg.hqAddress).toContain('Wolvenplein');
    expect(cfg.travelTimeMode).toBe('per_minute');
  });

  it('serves the cached value until the cache is cleared', async () => {
    const first = await getAppConfig(admin);
    expect(first.travelRateTrainerCentsPerKm).toBe(23);

    await setConfig(RATE_KEY, '30');

    // Still cached — no reload yet.
    const cached = await getAppConfig(admin);
    expect(cached.travelRateTrainerCentsPerKm).toBe(23);

    // Invalidate → reload picks up the new value.
    clearConfigCache();
    const reloaded = await getAppConfig(admin);
    expect(reloaded.travelRateTrainerCentsPerKm).toBe(30);
  });
});
