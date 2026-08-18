import { describe, expect, it } from 'vitest';

import { createStubTravelProvider, type RouteElement } from '../travel';
import type { CachedLeg } from '../travel-cache';
import { resolveTravel, type TravelCache } from '../travel-resolve';
import type { CandidateTrainer } from '../types';
import { NO_OVERRIDE } from '@lib/trainers/uurtarief';

const HQ = 'HQ Address';

function memCache(seed: Array<[string, CachedLeg]> = []): TravelCache {
  const store = new Map<string, CachedLeg>(seed);
  const key = (o: string, d: string, r: string): string => `${o}|${d}|${r}`;
  return {
    lookup: (o, d, r) => Promise.resolve(store.get(key(o, d, r)) ?? null),
    write: (row) => {
      store.set(key(row.originNorm, row.destinationNorm, row.routingKey), {
        condition: row.condition,
        distanceKm: row.distanceKm,
        durationMinutes: row.durationMinutes,
      });
      return Promise.resolve();
    },
  };
}

const okLeg: RouteElement = { status: 'ok', leg: { distanceKm: 10, durationMinutes: 30 } };
const hqOk: RouteElement = { status: 'ok', leg: { distanceKm: 12, durationMinutes: 40 } };

function providerFor(map: Record<string, RouteElement>, onCall?: () => void) {
  return createStubTravelProvider((origin) => {
    onCall?.();
    return map[origin] ?? okLeg;
  });
}

const trainer = (ext: string, adres: string | null): CandidateTrainer => ({
  externalItemId: ext,
  naam: ext,
  adres,
  mondayGroup: 'topics',
  rateKey: '2020-2024',
  rateOverride: NO_OVERRIDE,
});

describe('resolveTravel', () => {
  it('doubles legs to round-trip; excluded empty on all-ok', async () => {
    const provider = providerFor({ [HQ]: hqOk, 'A 1': okLeg });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') {
      return;
    }
    expect(res.byTrainer.get('t1')).toEqual({
      roundTripDistanceKm: 20,
      hqRoundTripDistanceKm: 24,
      roundTripDurationMinutes: 60,
    });
    expect(res.excluded).toHaveLength(0);
  });

  it('HQ not_found → FOUT (destination unreachable, never GEEN MATCH)', async () => {
    const provider = providerFor({ [HQ]: { status: 'not_found' } });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('fout');
  });

  it('HQ transient → FOUT', async () => {
    const provider = providerFor({ [HQ]: { status: 'transient', detail: 'x' } });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('fout');
  });

  it('a per-trainer ROUTE_NOT_FOUND excludes that trainer; others survive', async () => {
    const provider = providerFor({ [HQ]: hqOk, 'A 1': okLeg, 'B 2': { status: 'not_found' } });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1'), trainer('t2', 'B 2')],
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') {
      return;
    }
    expect(res.byTrainer.has('t1')).toBe(true);
    expect(res.byTrainer.has('t2')).toBe(false);
    expect(res.excluded).toContainEqual({ externalItemId: 't2', reason: 'route_not_found' });
  });

  it('a transient trainer failure → FOUT (never €0, never partial)', async () => {
    const provider = providerFor({ [HQ]: hqOk, 'A 1': { status: 'transient', detail: 'net' } });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('fout');
  });

  it('a trainer with no address is excluded (no_address), not €0', async () => {
    const provider = providerFor({ [HQ]: hqOk });
    const res = await resolveTravel(memCache(), provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', null)],
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') {
      return;
    }
    expect(res.excluded).toContainEqual({ externalItemId: 't1', reason: 'no_address' });
  });

  it('positive cache hits avoid the provider entirely', async () => {
    let calls = 0;
    const provider = providerFor({}, () => {
      calls += 1;
    });
    const cache = memCache([
      [
        'hq address|dest|stub:v1',
        { condition: 'ROUTE_EXISTS', distanceKm: 12, durationMinutes: 40 },
      ],
      ['a 1|dest|stub:v1', { condition: 'ROUTE_EXISTS', distanceKm: 10, durationMinutes: 30 }],
    ]);
    const res = await resolveTravel(cache, provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('ok');
    expect(calls).toBe(0);
    if (res.kind === 'ok') {
      expect(res.cacheHits).toBe(2); // HQ + one trainer
    }
  });

  it('a malformed cache row → FOUT, never zeroed free travel', async () => {
    const provider = providerFor({ 'a 1': okLeg });
    // ROUTE_EXISTS with null metrics is malformed → classified transient → HQ FOUT.
    const cache = memCache([
      [
        'hq address|dest|stub:v1',
        { condition: 'ROUTE_EXISTS', distanceKm: null, durationMinutes: null },
      ],
    ]);
    const res = await resolveTravel(cache, provider, {
      destination: 'Dest',
      hqAddress: HQ,
      trainers: [trainer('t1', 'A 1')],
    });
    expect(res.kind).toBe('fout');
  });
});
