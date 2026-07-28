import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithDeadline } from '../deadline';
import { fetchWithRetry, parseRetryAfter } from '../http';

const NO_DELAY = { baseDelayMs: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(status: number): Response {
  return new Response('body', { status });
}

describe('fetchWithRetry', () => {
  it('retries a transient 503 then returns the eventual success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://x', {}, NO_DELAY);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(400));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://x', {}, NO_DELAY);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries network errors and throws after exhausting attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithRetry('https://x', {}, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow(
      /ECONNRESET/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the last retryable response if all attempts stay 5xx', async () => {
    // Fresh Response per call — real fetch never reuses a (single-read) body.
    const fetchMock = vi.fn(() => Promise.resolve(response(500)));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://x', {}, { attempts: 2, baseDelayMs: 0 });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('buffers the body so callers can still read it after the timed window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://x', {}, NO_DELAY);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('honors a Retry-After (delta-seconds) on a 429, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://x', {}, { attempts: 2, baseDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung attempt after the timeout, then retries and gives up', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('https://x', {}, { attempts: 2, baseDelayMs: 0, timeoutMs: 5 })
    ).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithRetry run deadline', () => {
  it('fails fast without fetching once the run deadline has passed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runWithDeadline(0, () => fetchWithRetry('https://x', {}, NO_DELAY))
    ).rejects.toThrow(/deadline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still fetches when the run deadline is in the future', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await runWithDeadline(Date.now() + 60_000, () =>
      fetchWithRetry('https://x', {}, NO_DELAY)
    );
    expect(res.status).toBe(200);
  });
});

describe('parseRetryAfter', () => {
  const NOW = 1_000_000;

  it('parses delta-seconds to ms', () => {
    expect(parseRetryAfter('2', NOW)).toBe(2000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('parses an HTTP date to a non-negative delta', () => {
    const future = new Date(NOW + 5000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(5000);
    const past = new Date(NOW - 5000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0); // never negative
  });

  it('returns null for a missing or unparseable value', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
  });
});
