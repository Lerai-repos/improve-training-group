/**
 * The real {@link EvaluationSource}: Google Sheets over HTTPS.
 *
 * Auth is behind a one-method {@link GoogleAuth} interface, which is what makes the
 * choice between OAuth and a service account a ~30-line file rather than a rewrite —
 * and what lets everything below it be tested with a stub token and a stub `fetch`.
 *
 * We ended up on OAuth against `automation@lerai.nl` rather than a service account
 * because `iam.disableServiceAccountKeyCreation` is enforced org-wide on `lerai.nl` and
 * changing it needs org-level IAM nobody here holds. The consent app is registered
 * INTERNAL, which is load-bearing: an External app left in "Testing" has its refresh
 * token revoked after seven days, and that failure would land on a weekend.
 */

import { SHEETS_READONLY_SCOPE, type OAuthCredentials } from './sheet-documents';
import {
  decodeGrid,
  sheetValuesSchema,
  type EvaluationSource,
  type ReadResult,
  type SheetDecode,
  type SourceConfig,
} from './sheets-reader';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Per-request ceiling, so one stalled response cannot consume the whole run. */
const DEFAULT_TIMEOUT_MS = 20_000;
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Refresh a little early: a token that expires mid-flight fails the whole run. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleAuth {
  accessToken(): Promise<string>;
}

type FetchLike = typeof fetch;

/**
 * The run's absolute deadline, injected — the same shape the Monday clients take.
 *
 * `runWithDeadline` only makes the budget *available*; it cancels nothing on its own, so
 * a `fetch` that never consults it runs until Vercel kills the function and the route
 * never returns its controlled failure. Injected rather than imported because
 * `lib/evaluations` must not depend on `@lib/recommend`.
 */
export type DeadlineFn = () => number | null;

interface Bounded {
  signal: AbortSignal;
  done: () => void;
}

/**
 * An AbortSignal for one request: the sooner of the per-request timeout and whatever is
 * left of the run's budget. Throws before starting when the budget is already spent.
 */
function bound(deadlineMs: DeadlineFn | undefined, timeoutMs: number, what: string): Bounded {
  const deadline = deadlineMs?.() ?? null;
  const remaining = deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`${what}: run deadline exceeded before the request started`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * `fetch`, then buffer the body WHILE the abort timer is still armed.
 *
 * `fetch` resolves as soon as the headers arrive, so a server that stalls the body would
 * otherwise outlive the timeout entirely — the exact failure this bounding exists for.
 */
async function fetchBounded(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  deadlineMs: DeadlineFn | undefined,
  timeoutMs: number,
  what: string
): Promise<{ ok: boolean; status: number; text: string }> {
  const { signal, done } = bound(deadlineMs, timeoutMs, what);
  try {
    const response = await fetchImpl(url, { ...init, signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    done();
  }
}

/**
 * Exchange a refresh token for an access token, caching it until just before it expires.
 *
 * Single-flight: concurrent document reads must not each mint a token. Google tolerates
 * it, but it turns one failure into three and muddies the logs.
 */
export function createOAuthGoogleAuth(
  credentials: OAuthCredentials,
  fetchImpl: FetchLike = fetch,
  deadlineMs?: DeadlineFn
): GoogleAuth {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetchBounded(
      fetchImpl,
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      deadlineMs,
      DEFAULT_TIMEOUT_MS,
      'Google token exchange'
    );
    const { text } = response;
    if (!response.ok) {
      // `invalid_grant` is the one worth naming: it means the refresh token is gone —
      // revoked, or the account signed out everywhere — and the fix is a human action,
      // not a retry.
      const hint = text.includes('invalid_grant')
        ? ' — the refresh token is no longer valid; re-run `pnpm google:consent`'
        : '';
      throw new Error(`Google token exchange failed (${response.status}): ${text}${hint}`);
    }
    const parsed: { access_token?: unknown; expires_in?: unknown } = JSON.parse(text);
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new Error('Google token exchange returned no access_token');
    }
    const expiresInMs =
      typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in * 1000
        : 0;
    cached = {
      token: parsed.access_token,
      expiresAtMs: Date.now() + Math.max(0, expiresInMs - EXPIRY_MARGIN_MS),
    };
    return parsed.access_token;
  }

  return {
    async accessToken(): Promise<string> {
      if (cached !== null && Date.now() < cached.expiresAtMs) {
        return cached.token;
      }
      inFlight ??= mint().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** Everything after the spreadsheet id, percent-encoded — sheet names contain spaces. */
function valuesUrl(documentId: string, sheetName: string): string {
  const range = encodeURIComponent(sheetName);
  return `${SHEETS_API}/${encodeURIComponent(documentId)}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
}

/**
 * Which tabs the document actually has.
 *
 * Only called to enrich a failure. "Unable to parse range: X" is Google's way of saying
 * the tab does not exist, and it does not say what does — so the operator is left
 * guessing at a name they cannot see from the terminal. One of our tabs is literally
 * called `aaaa` because someone mistyped it, so the day that gets corrected this error
 * is what turns a dead nightly run into a one-line config change.
 */
async function tabNames(
  documentId: string,
  token: string,
  fetchImpl: FetchLike,
  deadlineMs?: DeadlineFn
): Promise<string[] | null> {
  try {
    const response = await fetchBounded(
      fetchImpl,
      `${SHEETS_API}/${encodeURIComponent(documentId)}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
      deadlineMs,
      DEFAULT_TIMEOUT_MS,
      'Google Sheets metadata'
    );
    if (!response.ok) {
      return null;
    }
    const parsed: { sheets?: Array<{ properties?: { title?: unknown } }> } = JSON.parse(response.text);
    return (parsed.sheets ?? []).flatMap((sheet) =>
      typeof sheet.properties?.title === 'string' ? [sheet.properties.title] : []
    );
  } catch {
    // Diagnostics must never replace the real error with their own.
    return null;
  }
}

/**
 * Read every configured document.
 *
 * THROWS on any failure, and never returns a partial result — the contract stated on
 * {@link EvaluationSource}. Zero responses where there should be thousands produces a
 * stats board on which every trainer has never been evaluated, and the nightly delta
 * would then blank the corpus to match.
 */
export function googleSheetsSource(
  auth: GoogleAuth,
  config: SourceConfig,
  fetchImpl: FetchLike = fetch,
  deadlineMs?: DeadlineFn
): EvaluationSource {
  return {
    async readResponses(): Promise<ReadResult> {
      const token = await auth.accessToken();
      const decoded: SheetDecode[] = [];

      // Sequential on purpose: three documents is not worth the concurrency, and a
      // 429 from Sheets is easier to reason about one request at a time.
      for (const document of config.documents) {
        const response = await fetchBounded(
          fetchImpl,
          valuesUrl(document.documentId, document.sheetName),
          { headers: { Authorization: `Bearer ${token}` } },
          deadlineMs,
          DEFAULT_TIMEOUT_MS,
          `Google Sheets read (${document.label})`
        );
        const { text } = response;
        if (!response.ok) {
          // A bad range means the TAB is wrong, and Google will not say which exist.
          const available =
            response.status === 400 && text.includes('Unable to parse range')
              ? await tabNames(document.documentId, token, fetchImpl, deadlineMs)
              : null;
          const hint =
            available !== null
              ? ` — tab "${document.sheetName}" does not exist. This document has: ` +
                available.map((name) => `"${name}"`).join(', ')
              : response.status === 403
                ? ' — the account has no access to this document, or the Sheets API is not enabled'
                : response.status === 404
                  ? ' — no such document; check the id'
                  : '';
          throw new Error(
            `Google Sheets read failed for "${document.label}" ` +
              `(${document.documentId}/${document.sheetName}): ${response.status} ${text}${hint}`
          );
        }

        const parsed = sheetValuesSchema.safeParse(JSON.parse(text));
        if (!parsed.success) {
          throw new Error(
            `Google Sheets returned an unexpected payload for "${document.label}": ` +
              `${parsed.error.issues[0]?.message ?? 'unknown shape'}`
          );
        }
        decoded.push(
          decodeGrid(parsed.data.values ?? [], {
            documentId: document.documentId,
            sheetName: document.sheetName,
            label: document.label,
          })
        );
      }

      return {
        responses: decoded.flatMap((d) => d.responses),
        sheets: decoded.map((d) => d.summary),
      };
    },
  };
}

/** The consent URL the one-time script opens. Exported so it can be asserted. */
export function consentUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SHEETS_READONLY_SCOPE,
    // Without BOTH of these Google returns only an access token on a repeat consent,
    // and the script would print nothing useful the second time it is run.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Swap the one-time authorization code for a refresh token. */
export async function exchangeCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch
): Promise<{ refreshToken: string }> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google code exchange failed (${response.status}): ${text}`);
  }
  const parsed: { refresh_token?: unknown } = JSON.parse(text);
  if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') {
    throw new Error(
      'Google returned no refresh_token. This happens when the account has already ' +
        'consented and `prompt=consent` was not sent — revoke the app at ' +
        'myaccount.google.com/permissions and try again.'
    );
  }
  return { refreshToken: parsed.refresh_token };
}
