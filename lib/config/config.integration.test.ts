import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '@lib/testing/supabase-clients';

import { clearConfigCache, CONFIG_TTL_MS, getAppConfig, setConfigClock } from './config';

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
    setConfigClock(); // restore the real clock
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

  it('expires the cache after the TTL, so an edit becomes visible without a restart', async () => {
    // Self-contained: don't rely on the seeded value surviving earlier tests.
    await setConfig(RATE_KEY, '23');

    // Injected clock — advance time rather than waiting a real minute.
    let clockMs = 1_000_000;
    setConfigClock(() => clockMs);
    clearConfigCache();

    expect((await getAppConfig(admin)).travelRateTrainerCentsPerKm).toBe(23);
    await setConfig(RATE_KEY, '31');

    // Just before the TTL → still the cached value.
    clockMs += CONFIG_TTL_MS - 1;
    expect((await getAppConfig(admin)).travelRateTrainerCentsPerKm).toBe(23);

    // Past the TTL → reloaded from the DB, no manual invalidation needed.
    clockMs += 2;
    expect((await getAppConfig(admin)).travelRateTrainerCentsPerKm).toBe(31);
  });

  it('exposes the configured recommendable trainer groups', async () => {
    const cfg = await getAppConfig(admin);
    expect(cfg.recommendableTrainerGroups).toEqual(['topics', 'nieuwe_groep__1']);
  });
});
