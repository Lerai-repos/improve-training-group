import { describe, expect, it } from 'vitest';

import {
  createRoutesProvider,
  parseRouteMatrixResponse,
  type RouteElement,
  type RoutesTransport,
} from '../travel';

describe('createRoutesProvider batch cap', () => {
  it('rejects a batch size above the 49 address-origin cap', () => {
    const noop: RoutesTransport = () => Promise.resolve([]);
    expect(() => createRoutesProvider(noop, { batchSize: 100 })).toThrow(/49/);
    expect(() => createRoutesProvider(noop, { batchSize: 0 })).toThrow();
  });
});

describe('parseRouteMatrixResponse', () => {
  it('ROUTE_EXISTS → ok leg (meters→km, seconds→minutes)', () => {
    const els = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 10000, duration: '1800s' }],
      1
    );
    expect(els[0]).toEqual({ status: 'ok', leg: { distanceKm: 10, durationMinutes: 30 } });
  });

  it('ROUTE_NOT_FOUND → terminal not_found', () => {
    const els = parseRouteMatrixResponse([{ originIndex: 0, condition: 'ROUTE_NOT_FOUND' }], 1);
    expect(els[0].status).toBe('not_found');
  });

  it('an element status error → transient (not a silent success)', () => {
    const els = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', status: { code: 3, message: 'bad' } }],
      1
    );
    expect(els[0].status).toBe('transient');
  });

  it('ROUTE_EXISTS with missing metrics → transient (never a zeroed free leg)', () => {
    const noDistance = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', duration: '600s' }],
      1
    );
    expect(noDistance[0].status).toBe('transient');
    const noDuration = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 5000 }],
      1
    );
    expect(noDuration[0].status).toBe('transient');
  });

  it('ROUTE_EXISTS with a malformed or negative duration → transient (strict parse)', () => {
    const cases = ['600ms', '600garbage', '-5s', '', '600'];
    for (const duration of cases) {
      const els = parseRouteMatrixResponse(
        [{ originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 5000, duration }],
        1
      );
      expect(els[0].status, `duration ${JSON.stringify(duration)}`).toBe('transient');
    }
    // Fractional protobuf durations are valid.
    const ok = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 5000, duration: '1.5s' }],
      1
    );
    expect(ok[0].status).toBe('ok');
  });

  it('a missing element for an origin → transient (never a zeroed success)', () => {
    const els = parseRouteMatrixResponse(
      [{ originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 5000, duration: '600s' }],
      2
    );
    expect(els[0].status).toBe('ok');
    expect(els[1].status).toBe('transient');
  });

  it('places elements by originIndex, not array order', () => {
    const els = parseRouteMatrixResponse(
      [
        { originIndex: 1, condition: 'ROUTE_NOT_FOUND' },
        { originIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1000, duration: '60s' },
      ],
      2
    );
    expect(els[0].status).toBe('ok');
    expect(els[1].status).toBe('not_found');
  });

  it('unparseable response → all transient', () => {
    expect(parseRouteMatrixResponse({ nope: true }, 2).every((e) => e.status === 'transient')).toBe(
      true
    );
  });
});

describe('createRoutesProvider batching', () => {
  it('splits origins into batches and concatenates results in order', async () => {
    const seen: number[] = [];
    const transport: RoutesTransport = (origins) => {
      seen.push(origins.length);
      return Promise.resolve(
        origins.map((_, i) => ({
          originIndex: i,
          condition: 'ROUTE_EXISTS',
          distanceMeters: 1000,
          duration: '60s',
        }))
      );
    };
    const provider = createRoutesProvider(transport, { batchSize: 2 });
    const els = await provider.distances(['a', 'b', 'c', 'd', 'e'], 'dest');
    expect(seen).toEqual([2, 2, 1]); // batched
    expect(els).toHaveLength(5);
    expect(els.every((e) => e.status === 'ok')).toBe(true);
  });

  it('a transport failure marks that whole batch transient (not zeroed)', async () => {
    const transport: RoutesTransport = (origins) => {
      if (origins.includes('boom')) {
        return Promise.reject(new Error('network'));
      }
      return Promise.resolve(
        origins.map((_, i) => ({
          originIndex: i,
          condition: 'ROUTE_EXISTS',
          distanceMeters: 1000,
          duration: '60s',
        }))
      );
    };
    const provider = createRoutesProvider(transport, { batchSize: 1, batchAttempts: 1 });
    const els: RouteElement[] = await provider.distances(['ok', 'boom'], 'dest');
    expect(els[0].status).toBe('ok');
    expect(els[1].status).toBe('transient');
  });

  it('does not batch-retry a transport throw (the transport owns HTTP retries)', async () => {
    let calls = 0;
    const transport: RoutesTransport = () => {
      calls += 1;
      return Promise.reject(new Error('net'));
    };
    const provider = createRoutesProvider(transport, { batchSize: 1, batchAttempts: 3 });
    const els = await provider.distances(['a'], 'dest');
    expect(calls).toBe(1); // one transport call, not 3
    expect(els[0].status).toBe('transient');
  });

  it('retries a batch that parses to transient elements, then succeeds', async () => {
    let calls = 0;
    const transport: RoutesTransport = (origins) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([]); // missing element → transient → retry
      }
      return Promise.resolve(
        origins.map((_, i) => ({
          originIndex: i,
          condition: 'ROUTE_EXISTS',
          distanceMeters: 1000,
          duration: '60s',
        }))
      );
    };
    const provider = createRoutesProvider(transport, { batchSize: 1, batchAttempts: 3 });
    const els = await provider.distances(['a'], 'dest');
    expect(calls).toBe(2);
    expect(els[0].status).toBe('ok');
  });
});
