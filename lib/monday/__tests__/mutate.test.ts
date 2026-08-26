import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMondayMutationClient } from '../mutate';

/**
 * The write transport. Its whole reason to exist is the failure mode the read client
 * cannot see: Monday answers a complexity refusal with **HTTP 200** and an `errors[]`
 * body, so every generic HTTP retry layer treats it as success.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

/** Stub `fetch` with a scripted sequence of responses, capturing every request. */
function stubFetch(responses: readonly Response[]): { calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) {
      headers[k] = String(v);
    }
    calls.push({ url, headers, body: JSON.parse(String(init.body)) });
    const res = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(res.clone());
  });
  return { calls };
}

const ok = (data: unknown): Response => new Response(JSON.stringify({ data }), { status: 200 });

const graphqlError = (errors: unknown[]): Response =>
  new Response(JSON.stringify({ errors }), { status: 200 });

function client(overrides: Partial<Parameters<typeof createMondayMutationClient>[0]> = {}) {
  return createMondayMutationClient({
    token: 'tok',
    apiVersion: '2026-07',
    // Keep the tests fast: the real backoff is seconds.
    baseBackoffMs: 1,
    ...overrides,
  });
}

const DOC = 'mutation ($board: ID!) { create_item(board_id: $board) { id } }';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMondayMutationClient', () => {
  it('posts the document and returns data', async () => {
    const { calls } = stubFetch([ok({ create_item: { id: '42' } })]);

    const result = await client().mutate<{ create_item: { id: string } }>(DOC, { board: '1' });

    expect(result.create_item.id).toBe('42');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.monday.com/v2');
    expect(calls[0].body.variables).toEqual({ board: '1' });
  });

  /** Monday wants the bare token — `Bearer` is rejected. */
  it('sends the token without a Bearer prefix, and the pinned API version', async () => {
    const { calls } = stubFetch([ok({ create_item: { id: '1' } })]);

    await client().mutate(DOC, {});

    expect(calls[0].headers.Authorization).toBe('tok');
    expect(calls[0].headers['API-Version']).toBe('2026-07');
  });

  it('sends an Idempotency-Key only when one is given', async () => {
    const { calls } = stubFetch([ok({ create_item: { id: '1' } })]);
    const c = client();

    await c.mutate(DOC, {}, { idempotencyKey: 'evalstats:c:1:2' });
    await c.mutate(DOC, {});

    expect(calls[0].headers['Idempotency-Key']).toBe('evalstats:c:1:2');
    expect(Object.keys(calls[1].headers)).not.toContain('Idempotency-Key');
  });

  it('throws on a non-2xx, quoting the body', async () => {
    stubFetch([new Response('nope', { status: 401 })]);

    await expect(client().mutate(DOC, {})).rejects.toThrow(/401.*nope/s);
  });

  /** GraphQL errors arrive as 200. Returning `data` here would be silent data loss. */
  it('throws on errors[] inside a 200', async () => {
    stubFetch([graphqlError([{ message: 'Label not found' }])]);

    await expect(client().mutate(DOC, {})).rejects.toThrow(/Label not found/);
  });

  it('throws when a 200 carries neither data nor errors', async () => {
    stubFetch([new Response(JSON.stringify({}), { status: 200 })]);

    await expect(client().mutate(DOC, {})).rejects.toThrow(/empty data/);
  });

  describe('complexity and rate refusals', () => {
    /**
     * The shape is quoted from Monday's own changelog for API 2025-07+, which is the
     * version we pin. Read `extensions.retry_in_seconds`; do not regex the message —
     * Monday reworded this error once already, and renamed its code with it.
     */
    it('waits the structured retry_in_seconds and retries', async () => {
      const { calls } = stubFetch([
        graphqlError([
          {
            message: 'Complexity budget exhausted',
            extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 0 },
          },
        ]),
        ok({ create_item: { id: '7' } }),
      ]);

      const result = await client().mutate<{ create_item: { id: string } }>(DOC, {});

      expect(result.create_item.id).toBe('7');
      expect(calls).toHaveLength(2);
    });

    it('gives up after the retry budget and throws', async () => {
      const { calls } = stubFetch([
        graphqlError([
          {
            message: 'busy',
            extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 0 },
          },
        ]),
      ]);

      await expect(client({ complexityRetries: 2 }).mutate(DOC, {})).rejects.toThrow(/busy/);
      expect(calls).toHaveLength(3); // the first attempt plus two retries
    });

    /** A non-transient GraphQL error must not be retried — it will never succeed. */
    it('does not retry an ordinary GraphQL error', async () => {
      const { calls } = stubFetch([graphqlError([{ message: 'Label not found' }])]);

      await expect(client().mutate(DOC, {})).rejects.toThrow(/Label not found/);
      expect(calls).toHaveLength(1);
    });

    /**
     * The pre-2025-07 code, still what the rate-limits page documents. Carried because
     * being wrong about the name means never retrying at all — and here it arrives
     * WITHOUT `retry_in_seconds`, so only the code can save it.
     */
    it('recognises the legacy ComplexityException code with no retry hint', async () => {
      const { calls } = stubFetch([
        graphqlError([{ message: 'busy', extensions: { code: 'ComplexityException' } }]),
        ok({ create_item: { id: '9' } }),
      ]);

      await expect(client().mutate(DOC, {})).resolves.toBeDefined();
      expect(calls).toHaveLength(2);
    });

    it('retries a concurrency refusal', async () => {
      const { calls } = stubFetch([
        graphqlError([
          {
            message: 'busy',
            extensions: { code: 'Concurrency limit exceeded', retry_in_seconds: 0 },
          },
        ]),
        ok({ create_item: { id: '9' } }),
      ]);

      await expect(client().mutate(DOC, {})).resolves.toBeDefined();
      expect(calls).toHaveLength(2);
    });

    /**
     * The daily budget resets at midnight, so a retry cannot succeed inside this run —
     * and Monday may still attach a `retry_in_seconds`. Sleeping on it would burn the
     * run and fail anyway, so the terminal code has to win over the field.
     */
    it('never retries the daily limit, even when it carries retry_in_seconds', async () => {
      const { calls } = stubFetch([
        graphqlError([
          {
            message: 'Daily limit exceeded',
            extensions: { code: 'DAILY_LIMIT_EXCEEDED', retry_in_seconds: 5 },
          },
        ]),
      ]);

      await expect(client().mutate(DOC, {})).rejects.toThrow(/Daily limit exceeded/);
      expect(calls).toHaveLength(1);
    });

    /**
     * Completing at all IS the assertion: without the cap this sleeps for a day and
     * the test times out. A wall-clock `toBeLessThan` would only add flakiness.
     */
    it('caps an absurd retry_in_seconds instead of sleeping through the run', async () => {
      stubFetch([
        graphqlError([
          {
            message: 'busy',
            extensions: { code: 'ComplexityException', retry_in_seconds: 86_400 },
          },
        ]),
      ]);

      await expect(
        client({ complexityRetries: 1, maxBackoffMs: 5 }).mutate(DOC, {})
      ).rejects.toThrow(/busy/);
    });
  });

  describe('transport-level retry', () => {
    /**
     * `Number(null)` is `0`, which is finite and non-negative — so reading the header
     * without checking for its absence turns "no Retry-After" into "retry immediately"
     * and removes the backoff on exactly the failures it exists for.
     */
    it('backs off when a retryable status carries no Retry-After', async () => {
      const started = Date.now();
      const { calls } = stubFetch([
        new Response('busy', { status: 503 }),
        ok({ create_item: { id: '1' } }),
      ]);

      await client({ attempts: 2, baseBackoffMs: 40 }).mutate(DOC, {});

      expect(calls).toHaveLength(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    });

    /**
     * Monday answers 409 with a `Retry-After` when the SAME idempotency key arrives while
     * the original is still being processed. That is the situation the key exists to create:
     * the duplicate is held back and the original goes through. Throwing would tell the
     * caller the mutation failed at the moment it is actually succeeding.
     */
    it('retries a 409 while an idempotent mutation is still in flight', async () => {
      const { calls } = stubFetch([
        new Response('in flight', { status: 409, headers: { 'retry-after': '0' } }),
        ok({ create_item: { id: '1' } }),
      ]);

      const uit = await client({ attempts: 2 }).mutate(DOC, {}, { idempotencyKey: 'briefing:1' });

      expect(calls).toHaveLength(2);
      expect(uit).toEqual({ create_item: { id: '1' } });
    });

    /** Zonder sleutel is 409 een echte botsing en hoort hij gewoon door te reizen. */
    it('does not retry a 409 without an idempotency key', async () => {
      const { calls } = stubFetch([
        new Response('conflict', { status: 409 }),
        ok({ create_item: { id: '1' } }),
      ]);

      await expect(client({ attempts: 2 }).mutate(DOC, {})).rejects.toThrow('409');
      expect(calls).toHaveLength(1);
    });

    /** En de sleutel moet écht meegaan als header, anders doet Monday er niets mee. */
    it('sends the idempotency key as a header', async () => {
      const { calls } = stubFetch([ok({ create_item: { id: '1' } })]);

      await client().mutate(DOC, {}, { idempotencyKey: 'briefing-row:900:https://sp/a.docx' });

      expect(calls[0]?.headers['Idempotency-Key']).toBe('briefing-row:900:https://sp/a.docx');
    });

    it('honours a Retry-After when the server sends one', async () => {
      const { calls } = stubFetch([
        new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
        ok({ create_item: { id: '1' } }),
      ]);

      await client({ attempts: 2 }).mutate(DOC, {});

      expect(calls).toHaveLength(2);
    });
  });

  describe('the deadline', () => {
    it('refuses to start once the deadline has passed', async () => {
      const { calls } = stubFetch([ok({ create_item: { id: '1' } })]);

      await expect(client({ deadlineMs: () => Date.now() - 1 }).mutate(DOC, {})).rejects.toThrow(
        /deadline/
      );
      expect(calls).toHaveLength(0);
    });

    /**
     * A retry that outlives its budget is worse than no retry: the caller is killed
     * mid-sleep and cannot finalize.
     */
    it('never sleeps past the deadline', async () => {
      const deadline = Date.now() + 20;
      stubFetch([
        graphqlError([
          {
            message: 'busy',
            extensions: { code: 'ComplexityException', retry_in_seconds: 30 },
          },
        ]),
      ]);

      // Three retries × 30s would far outlast the 20ms budget; finishing proves the
      // sleep was clipped and the next round then failed fast.
      await expect(
        client({ complexityRetries: 3, deadlineMs: () => deadline }).mutate(DOC, {})
      ).rejects.toThrow();
    });

    it('imposes no bound when no deadline is injected', async () => {
      stubFetch([ok({ create_item: { id: '1' } })]);

      await expect(client({ deadlineMs: undefined }).mutate(DOC, {})).resolves.toBeDefined();
    });
  });
});
