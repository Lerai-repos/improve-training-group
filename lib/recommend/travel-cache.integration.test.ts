import { beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '@lib/testing/supabase-clients';

import { lookupTravel, NEGATIVE_TTL_MS, writeTravel } from './travel-cache';

const admin = adminClient();
const RK = 'google-routes:DRIVE:TRAFFIC_UNAWARE:v1';

beforeEach(async () => {
  await admin.from('travel_cache').delete().gte('fetched_at', '1900-01-01');
});

describe('travel_cache lookup/write', () => {
  it('a positive row is written and read back regardless of age', async () => {
    await writeTravel(admin, {
      originNorm: 'a',
      destinationNorm: 'z',
      routingKey: RK,
      condition: 'ROUTE_EXISTS',
      distanceKm: 12.5,
      durationMinutes: 20,
    });
    const hit = await lookupTravel(admin, 'a', 'z', RK);
    expect(hit).toEqual({ condition: 'ROUTE_EXISTS', distanceKm: 12.5, durationMinutes: 20 });
  });

  it('a fresh negative row is a hit; past its TTL it is a miss (re-fetch)', async () => {
    await writeTravel(admin, {
      originNorm: 'a',
      destinationNorm: 'z',
      routingKey: RK,
      condition: 'ROUTE_NOT_FOUND',
      distanceKm: null,
      durationMinutes: null,
    });
    // Fresh: hit.
    expect((await lookupTravel(admin, 'a', 'z', RK))?.condition).toBe('ROUTE_NOT_FOUND');
    // Simulate "now" well past the negative TTL → miss.
    const future = Date.now() + NEGATIVE_TTL_MS + 60_000;
    expect(await lookupTravel(admin, 'a', 'z', RK, future)).toBeNull();
  });

  it('the routing key isolates rows (different profile → separate cache entry)', async () => {
    await writeTravel(admin, {
      originNorm: 'a',
      destinationNorm: 'z',
      routingKey: RK,
      condition: 'ROUTE_EXISTS',
      distanceKm: 5,
      durationMinutes: 10,
    });
    expect(await lookupTravel(admin, 'a', 'z', 'other-routing-key')).toBeNull();
  });

  it('a re-write upserts (refreshes) the same key', async () => {
    const base = { originNorm: 'a', destinationNorm: 'z', routingKey: RK };
    await writeTravel(admin, {
      ...base,
      condition: 'ROUTE_EXISTS',
      distanceKm: 1,
      durationMinutes: 1,
    });
    await writeTravel(admin, {
      ...base,
      condition: 'ROUTE_EXISTS',
      distanceKm: 9,
      durationMinutes: 9,
    });
    expect((await lookupTravel(admin, 'a', 'z', RK))?.distanceKm).toBe(9);
    // One row total (the re-write upserted rather than inserting a second).
    const { count } = await admin.from('travel_cache').select('*', { count: 'exact', head: true });
    expect(count).toBe(1);
  });
});
