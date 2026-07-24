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
