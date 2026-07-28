import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMondayGraphQLClient } from '../graphql-client';

const client = () =>
  createMondayGraphQLClient({ token: 'tok', apiVersion: '2026-07', maxRetries: 0 });

function stubFetch(body: unknown, headers: Record<string, string>, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MondayGraphQLClient (read-only, fail-closed)', () => {
  it('rejects a mutation document before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(client().query('mutation { change_column_value { id } }')).rejects.toThrow(
      /mutation/i
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when the response reports a different API-Version (silent fallback)', async () => {
    stubFetch(
      { data: { ok: 1 } },
      { 'API-Version': '2026-04', 'Content-Type': 'application/json' }
    );
    await expect(client().query('query { me { id } }')).rejects.toThrow(/API-Version mismatch/);
  });

  it('surfaces GraphQL errors returned inside a 200 body', async () => {
    stubFetch(
      { errors: [{ message: 'boom' }] },
      { 'API-Version': '2026-07', 'Content-Type': 'application/json' }
    );
    await expect(client().query('query { me { id } }')).rejects.toThrow(/boom/);
  });

  it('returns data on a healthy, version-matched response', async () => {
    stubFetch(
      { data: { me: { id: '1' } } },
      { 'API-Version': '2026-07', 'Content-Type': 'application/json' }
    );
    const r = await client().query<{ me: { id: string } }>('query { me { id } }');
    expect(r.me.id).toBe('1');
  });
});

describe('MondayGraphQLClient deadline', () => {
  it('fails fast without fetching when the injected deadline has passed', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bounded = createMondayGraphQLClient({
      token: 'tok',
      apiVersion: '2026-07',
      deadlineMs: () => 0, // epoch → already past
    });
    await expect(bounded.query('query { me { id } }')).rejects.toThrow(/deadline exceeded/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops retrying a 429 once the deadline passes (does not burn all attempts)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 429,
          // An uncapped Retry-After would otherwise sleep far past the deadline.
          headers: { 'Retry-After': '600', 'API-Version': '2026-07' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    // Deadline 20ms out: the first attempt runs, the bounded sleep ends at the
    // deadline, and the second attempt fails fast instead of doing 5 × 30s + sleeps.
    const deadline = Date.now() + 20;
    const bounded = createMondayGraphQLClient({
      token: 'tok',
      apiVersion: '2026-07',
      deadlineMs: () => deadline,
    });
    await expect(bounded.query('query { me { id } }')).rejects.toThrow(/deadline exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is unbounded when no deadline is injected (M2a sync behaviour unchanged)', async () => {
    stubFetch(
      { data: { me: { id: '1' } } },
      { 'API-Version': '2026-07', 'Content-Type': 'application/json' }
    );
    const r = await client().query<{ me: { id: string } }>('query { me { id } }');
    expect(r.me.id).toBe('1');
  });

  it('aborts a stalled response BODY (the timer stays armed through the body read)', async () => {
    // Headers arrive immediately, then the body never completes. The timer must still
    // be armed — otherwise this streams forever past the timeout and the deadline.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const stream = new ReadableStream({
          start(ctrl) {
            init?.signal?.addEventListener('abort', () => {
              ctrl.error(new Error('aborted'));
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'API-Version': '2026-07' } })
        );
      })
    );
    const bounded = createMondayGraphQLClient({
      token: 'tok',
      apiVersion: '2026-07',
      maxRetries: 0,
      timeoutMs: 10,
    });
    await expect(bounded.query('query { me { id } }')).rejects.toThrow(/abort/i);
  });

  it('reports an unparseable body clearly instead of a raw JSON error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>gateway</html>', {
            status: 200,
            headers: { 'API-Version': '2026-07' },
          })
        )
      )
    );
    const c = createMondayGraphQLClient({ token: 'tok', apiVersion: '2026-07', maxRetries: 0 });
    await expect(c.query('query { me { id } }')).rejects.toThrow(/unparseable response body/);
  });
});
