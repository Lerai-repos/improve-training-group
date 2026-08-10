import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createRecommendationsApi } from '../api';
import { fakeMonday, readyView, row } from './fakes';

/**
 * The token lifecycle, which is the part of this client that cannot be seen by reading
 * it: a token captured when the view opened expires while the view stays open, so a
 * planner who leaves an item on screen over lunch would come back to a list that
 * silently stopped refreshing.
 */

/**
 * Fresh `Response` objects per call, never a shared one.
 *
 * A body can only be read once, so `mockResolvedValue(ok(...))` hands the same consumed
 * stream to the second call and it fails as "not JSON" — which looks exactly like a
 * server bug rather than a test one.
 */
const ok = (body: unknown) => (): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const status = (code: number, body: unknown) => (): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRecommendationsApi', () => {
  it('sends a freshly minted token on every call', async () => {
    const monday = fakeMonday();
    const fetchMock = vi.fn().mockImplementation(ok({ success: true, data: readyView([row()]) }));
    vi.stubGlobal('fetch', fetchMock);

    const api = createRecommendationsApi(monday);
    await api.get('111');
    await api.get('111');

    expect(monday.tokens).toEqual(['token-1', 'token-2']);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
  });

  /** The token can expire between being fetched and being used. One retry covers it. */
  it('retries once with a new token on 401', async () => {
    const monday = fakeMonday();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(status(401, { success: false, error: 'unauthorized' }))
      .mockImplementationOnce(ok({ success: true, data: readyView([row()]) }));
    vi.stubGlobal('fetch', fetchMock);

    const view = await createRecommendationsApi(monday).get('111');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(monday.tokens).toEqual(['token-1', 'token-2']);
    expect(view.state.kind).toBe('ready');
  });

  /**
   * Exactly one retry. A second 401 means the answer really is "you may not", and
   * retrying further would turn a clear refusal into a hang.
   */
  it('gives up after one retry', async () => {
    const monday = fakeMonday();
    const fetchMock = vi.fn().mockImplementation(status(401, { success: false, error: 'unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRecommendationsApi(monday).get('111')).rejects.toThrow(/unauthorized/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('carries the status so a caller can tell 409 from a real failure', async () => {
    const monday = fakeMonday();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(status(409, { success: false, error: 'generation 1 is stale' }))
    );

    const failure = await createRecommendationsApi(monday)
      .setApproached('111', { generation: 1, trainerItemId: '900', approached: true })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409 });
  });

  it('refuses a response it cannot recognize rather than rendering nonsense', async () => {
    const monday = fakeMonday();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(ok({ success: true, data: { nope: 1 } })));

    await expect(createRecommendationsApi(monday).get('111')).rejects.toThrow(/unrecognizable/);
  });

  it('escapes the item id into the path', async () => {
    const monday = fakeMonday();
    const fetchMock = vi.fn().mockImplementation(ok({ success: true, data: readyView([row()]) }));
    vi.stubGlobal('fetch', fetchMock);

    await createRecommendationsApi(monday).get('../secrets');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/recommendations/..%2Fsecrets');
  });
});
