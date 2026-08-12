import { describe, expect, it } from 'vitest';

import {
  consentUrl,
  createOAuthGoogleAuth,
  exchangeCode,
  googleSheetsSource,
} from '../google-sheets-source';

import type { SourceConfig } from '../sheets-reader';

/**
 * The transport. Everything below it is already covered by `sheets-reader.test.ts`, so
 * what matters here is the auth lifecycle and the failure messages — the two things that
 * decide whether a 02:45 failure is diagnosable from the log alone.
 */

const CREDENTIALS = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh' };

const CONFIG: SourceConfig = {
  documents: [{ documentId: 'doc-nl', sheetName: 'Formulierreacties 1', label: 'nl' }],
};

const SHEET = {
  range: 'Formulierreacties 1!A1:Q100',
  majorDimension: 'ROWS' as const,
  values: [
    ['Tijdstempel', 'Code', 'Welk eindcijfer zou je de sessie geven?'],
    ['11-3-2025 13:54:46', 'C17', '7'],
  ],
};

interface Call {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
}

/** A `fetch` double that answers the token endpoint and the Sheets API separately. */
function stub(opts: {
  token?: Response | (() => Response);
  sheet?: Response | ((url: string) => Response);
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      authorization: headers.get('authorization'),
    });
    if (url.includes('oauth2.googleapis.com')) {
      const token = opts.token ?? okToken();
      return Promise.resolve(typeof token === 'function' ? token() : token.clone());
    }
    const sheet = opts.sheet ?? okSheet();
    return Promise.resolve(typeof sheet === 'function' ? sheet(url) : sheet.clone());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const okToken = (expiresIn = 3600): Response =>
  new Response(JSON.stringify({ access_token: 'at-1', expires_in: expiresIn }), { status: 200 });
const okSheet = (): Response => new Response(JSON.stringify(SHEET), { status: 200 });

describe('createOAuthGoogleAuth', () => {
  it('exchanges the refresh token for an access token', async () => {
    const { fetchImpl, calls } = stub({});

    const token = await createOAuthGoogleAuth(CREDENTIALS, fetchImpl).accessToken();

    expect(token).toBe('at-1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[0].body).toContain('refresh_token=refresh');
  });

  it('caches the token instead of minting one per document', async () => {
    const { fetchImpl, calls } = stub({});
    const auth = createOAuthGoogleAuth(CREDENTIALS, fetchImpl);

    await auth.accessToken();
    await auth.accessToken();

    expect(calls).toHaveLength(1);
  });

  /** Concurrent reads must not each mint: one failure would become three in the log. */
  it('single-flights concurrent requests', async () => {
    const { fetchImpl, calls } = stub({});
    const auth = createOAuthGoogleAuth(CREDENTIALS, fetchImpl);

    await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);

    expect(calls).toHaveLength(1);
  });

  /** A token that expires mid-run fails everything after it, so refresh early. */
  it('re-mints when the cached token is within the expiry margin', async () => {
    const { fetchImpl, calls } = stub({ token: () => okToken(30) });
    const auth = createOAuthGoogleAuth(CREDENTIALS, fetchImpl);

    await auth.accessToken();
    await auth.accessToken();

    expect(calls).toHaveLength(2);
  });

  /**
   * `invalid_grant` means the token is gone — revoked, or the account was signed out
   * everywhere. A retry cannot fix it, so the message has to say what will.
   */
  it('names the human action when the refresh token has been revoked', async () => {
    const { fetchImpl } = stub({
      token: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });

    await expect(createOAuthGoogleAuth(CREDENTIALS, fetchImpl).accessToken()).rejects.toThrow(
      /google:consent/
    );
  });

  it('throws when the response carries no access token', async () => {
    const { fetchImpl } = stub({
      token: () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    });

    await expect(createOAuthGoogleAuth(CREDENTIALS, fetchImpl).accessToken()).rejects.toThrow(
      /no access_token/
    );
  });
});

describe('googleSheetsSource', () => {
  const auth = { accessToken: () => Promise.resolve('at-1') };

  it('reads a document and decodes its rows', async () => {
    const { fetchImpl, calls } = stub({});

    const { responses, sheets } = await googleSheetsSource(auth, CONFIG, fetchImpl).readResponses();

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ rawCode: 'C17', grade: 7 });
    expect(sheets[0].source.label).toBe('nl');
    expect(calls[0].authorization).toBe('Bearer at-1');
  });

  /** The tab name contains a space; an unencoded range is a 400 from Sheets. */
  it('percent-encodes the sheet name into the range', async () => {
    const { fetchImpl, calls } = stub({});

    await googleSheetsSource(auth, CONFIG, fetchImpl).readResponses();

    expect(calls[0].url).toContain('/values/Formulierreacties%201');
    expect(calls[0].url).toContain('valueRenderOption=FORMATTED_VALUE');
  });

  it('reads every configured document into one list', async () => {
    const { fetchImpl, calls } = stub({});
    const two: SourceConfig = {
      documents: [
        ...CONFIG.documents,
        { documentId: 'doc-old', sheetName: 'Formulierreacties 1', label: 'oud-2025' },
      ],
    };

    const { responses, sheets } = await googleSheetsSource(auth, two, fetchImpl).readResponses();

    expect(sheets.map((s) => s.source.label)).toEqual(['nl', 'oud-2025']);
    expect(responses).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('sheets.googleapis.com'))).toHaveLength(2);
  });

  it('accepts an empty tab, where `values` is absent', async () => {
    const { fetchImpl } = stub({
      sheet: () => new Response(JSON.stringify({ range: 'A1:Q1' }), { status: 200 }),
    });

    // No header row at all is still a refusal — an empty sheet cannot be validated.
    await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
      /empty/
    );
  });

  describe('failures name what to do', () => {
    it('explains a 403 as access or a disabled API', async () => {
      const { fetchImpl } = stub({ sheet: () => new Response('denied', { status: 403 }) });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /no access to this document, or the Sheets API is not enabled/
      );
    });

    it('explains a 404 as a wrong document id', async () => {
      const { fetchImpl } = stub({ sheet: () => new Response('nope', { status: 404 }) });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /no such document; check the id/
      );
    });

    /**
     * Google answers a wrong tab with "Unable to parse range" and does NOT say which
     * tabs exist, leaving an operator guessing at a name they cannot see. One of the real
     * documents has a tab called `aaaa` because somebody mistyped it, so the day that is
     * corrected this is what turns a dead nightly run into a one-line config change.
     */
    it('lists the tabs that DO exist when the range is rejected', async () => {
      const { fetchImpl } = stub({
        sheet: (url) =>
          url.includes('/values/')
            ? new Response(
                JSON.stringify({ error: { message: 'Unable to parse range: Nope' } }),
                { status: 400 }
              )
            : new Response(
                JSON.stringify({ sheets: [{ properties: { title: 'aaaa' } }] }),
                { status: 200 }
              ),
      });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /does not exist. This document has: "aaaa"/
      );
    });

    /** A failing diagnostic must not replace the real error with its own. */
    it('still reports the range failure when the tab list cannot be fetched', async () => {
      const { fetchImpl } = stub({
        sheet: (url) =>
          url.includes('/values/')
            ? new Response(JSON.stringify({ error: { message: 'Unable to parse range: Nope' } }), {
                status: 400,
              })
            : new Response('denied', { status: 403 }),
      });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /Unable to parse range/
      );
    });

    /** Which document failed matters when three are configured. */
    it('names the document that failed', async () => {
      const { fetchImpl } = stub({ sheet: () => new Response('x', { status: 500 }) });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /"nl".*doc-nl/s
      );
    });

    it('rejects a payload that is not a values response', async () => {
      const { fetchImpl } = stub({
        sheet: () => new Response(JSON.stringify({ surprise: true }), { status: 200 }),
      });

      await expect(googleSheetsSource(auth, CONFIG, fetchImpl).readResponses()).rejects.toThrow(
        /unexpected payload/
      );
    });
  });
});

describe('the run deadline', () => {
  /**
   * `runWithDeadline` publishes the budget; it cancels nothing. A request that never
   * consults it runs until Vercel kills the function, and the route never returns its
   * controlled failure — so the bound has to be applied here, per request.
   */
  it('refuses to start once the budget is spent', async () => {
    const { fetchImpl, calls } = stub({});
    const past = () => Date.now() - 1;

    await expect(
      googleSheetsSource({ accessToken: () => Promise.resolve('at') }, CONFIG, fetchImpl, past)
        .readResponses()
    ).rejects.toThrow(/deadline exceeded/);
    expect(calls).toHaveLength(0);
  });

  it('passes an abort signal to every request', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return Promise.resolve(okSheet());
    }) as unknown as typeof fetch;

    await googleSheetsSource(
      { accessToken: () => Promise.resolve('at') },
      CONFIG,
      fetchImpl,
      () => Date.now() + 60_000
    ).readResponses();

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('bounds the token exchange as well as the reads', async () => {
    const { fetchImpl } = stub({});

    await expect(
      createOAuthGoogleAuth(CREDENTIALS, fetchImpl, () => Date.now() - 1).accessToken()
    ).rejects.toThrow(/deadline exceeded/);
  });

  /** No deadline injected — scripts and tests — imposes no run-level bound. */
  it('works unbounded when no deadline is given', async () => {
    const { fetchImpl } = stub({});

    await expect(
      googleSheetsSource({ accessToken: () => Promise.resolve('at') }, CONFIG, fetchImpl)
        .readResponses()
    ).resolves.toBeDefined();
  });
});

describe('the one-time consent', () => {
  /**
   * Both parameters are load-bearing. Without `access_type=offline` Google returns no
   * refresh token at all; without `prompt=consent` it returns none on a REPEAT consent,
   * which is the second-run failure that wastes an afternoon.
   */
  it('asks for offline access and forces the consent screen', () => {
    const url = consentUrl('cid', 'http://localhost:1234/oauth/callback');

    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('spreadsheets.readonly');
    expect(url).toContain(encodeURIComponent('http://localhost:1234/oauth/callback'));
  });

  it('exchanges the code for a refresh token', async () => {
    const { fetchImpl, calls } = stub({
      token: () => new Response(JSON.stringify({ refresh_token: '1//09xyz' }), { status: 200 }),
    });

    const result = await exchangeCode(
      { clientId: 'cid', clientSecret: 's', code: 'abc', redirectUri: 'http://localhost/cb' },
      fetchImpl
    );

    expect(result.refreshToken).toBe('1//09xyz');
    expect(calls[0].body).toContain('grant_type=authorization_code');
  });

  it('explains the empty-refresh-token case, which is the one that catches people', async () => {
    const { fetchImpl } = stub({
      token: () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }),
    });

    await expect(
      exchangeCode(
        { clientId: 'cid', clientSecret: 's', code: 'abc', redirectUri: 'http://localhost/cb' },
        fetchImpl
      )
    ).rejects.toThrow(/already consented.*myaccount\.google\.com\/permissions/s);
  });
});
