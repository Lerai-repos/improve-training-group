import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECOMMENDATION_STATUS_COLUMN } from '@lib/monday/board-config';

import { createMondayStatusWriter } from '../monday-status';

const OUR_COLUMN = 'color_ours0001';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

function captureFetch(): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) {
      headers[k] = String(v);
    }
    calls.push({ url, headers, body: JSON.parse(String(init.body)) });
    return Promise.resolve(
      new Response(JSON.stringify({ data: { change_column_value: { id: '1' } } }), { status: 200 })
    );
  });
  return { calls };
}

function writer(columnId: string = OUR_COLUMN) {
  return createMondayStatusWriter({
    token: 't',
    apiVersion: '2026-07',
    boardId: '5087396949',
    columnId,
  });
}

beforeEach(() => {
  process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN = OUR_COLUMN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN;
});

describe('createMondayStatusWriter', () => {
  it('writes a terminal label to OUR column', async () => {
    const { calls } = captureFetch();
    await writer().writeStatus('5029726254', 'GEREED');

    expect(calls).toHaveLength(1);
    expect(calls[0].body.variables).toMatchObject({
      item: '5029726254',
      col: OUR_COLUMN,
      val: JSON.stringify({ label: 'GEREED' }),
    });
  });

  /**
   * The guard that structurally protects the side-by-side rollout. n8n owns
   * `color_mkzwfy42`; if this engine could write it, our runs would silently take
   * over the legacy flow and there would be nothing left to compare against.
   */
  it('REFUSES to write n8n’s legacy column', async () => {
    const { calls } = captureFetch();
    await expect(writer(RECOMMENDATION_STATUS_COLUMN).writeStatus('1', 'GEREED')).rejects.toThrow(
      /refusing/i
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-terminal label — RUN would re-trigger our own webhook', async () => {
    const { calls } = captureFetch();
    // Widened handle rather than a cast: the point is the RUNTIME guard, since a
    // label reaching here from parsed JSON has no compile-time protection at all.
    const unsafe: { writeStatus(itemId: string, label: string): Promise<void> } = writer();
    await expect(unsafe.writeStatus('1', 'RUN')).rejects.toThrow(/refusing/i);
    expect(calls).toHaveLength(0);
  });

  it('sends a deterministic Idempotency-Key so a redelivery cannot double-apply', async () => {
    const { calls } = captureFetch();
    await writer().writeStatus('5029726254', 'GEREED', { idempotencyKey: '5029726254:3' });
    expect(calls[0].headers['Idempotency-Key']).toBe('5029726254:3');
  });

  it('omits the header when no key is supplied', async () => {
    const { calls } = captureFetch();
    await writer().writeStatus('5029726254', 'GEREED');
    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('throws on a GraphQL error body rather than reporting success', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: 'ColumnValueException' }] }), {
          status: 200,
        })
      )
    );
    await expect(writer().writeStatus('1', 'FOUT')).rejects.toThrow(/ColumnValueException/);
  });
});
