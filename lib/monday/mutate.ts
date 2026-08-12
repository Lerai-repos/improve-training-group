/**
 * The Monday WRITE transport — the only generic one.
 *
 * It exists as its own module because the read client
 * (`createMondayGraphQLClient`) rejects any document containing the word `mutation`,
 * on purpose: "reads cannot write" is enforced structurally rather than by review.
 * Writers therefore bring their own transport, as `monday-status.ts` already does for
 * the status label. This generalizes that transport for callers that write more than
 * one column, WITHOUT touching the delivery path that is already in production.
 *
 * What it adds over a plain `fetch` loop is the failure mode nothing else can see:
 * **Monday answers a complexity refusal with HTTP 200** and an `errors[]` body, so
 * every status-code-based retry layer reads it as success and every caller reads it as
 * a write that happened. This one inspects the body, and backs off on the structured
 * `extensions.retry_in_seconds` rather than on the message text — Monday has already
 * reworded that error once.
 *
 * The deadline is INJECTED (`deadlineMs`), exactly as the read client takes it, so this
 * module stays free of `lib/recommend`: `lib/monday` currently imports nothing from
 * there and that boundary is worth keeping.
 */

const DEFAULT_ENDPOINT = 'https://api.monday.com/v2';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Two attempts against transient HTTP failures; a write is not worth a long tail. */
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_BASE_BACKOFF_MS = 300;
/**
 * Monday's suggested wait is honoured but capped. An over-long window would otherwise
 * park the whole run inside one sleep; at the cap we simply try again and fail loudly
 * if it is still refusing.
 */
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** How many times a COMPLEXITY refusal is retried, beyond the first attempt. */
const DEFAULT_COMPLEXITY_RETRIES = 2;
const SECONDS_TO_MS = 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export interface MutateOptions {
  /**
   * Monday suppresses a repeat of the SAME mutation for 30 minutes. Whether that is a
   * safeguard or a bug depends entirely on the key: see the two schemes in
   * `trainer-thema-board.ts`.
   */
  idempotencyKey?: string;
}

export interface MondayMutationClientOptions {
  token: string;
  apiVersion: string;
  endpoint?: string;
  timeoutMs?: number;
  attempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  complexityRetries?: number;
  /** Absolute ms-epoch deadline for the whole run, or null when unbounded. */
  deadlineMs?: () => number | null;
}

export interface MondayMutationClient {
  mutate<T>(
    document: string,
    variables?: Record<string, unknown>,
    opts?: MutateOptions
  ): Promise<T>;
}

interface GraphQLError {
  message?: unknown;
  extensions?: { code?: unknown; retry_in_seconds?: unknown } | null;
}

/** The message text, for humans. Never parsed for control flow. */
function describe(errors: readonly GraphQLError[]): string {
  const messages = errors.map((e) => (typeof e.message === 'string' ? e.message : 'unknown error'));
  return messages.join('; ');
}

/**
 * Codes that mean "try again shortly". Monday renamed the complexity one in API
 * 2025-07 (`ComplexityException` → `COMPLEXITY_BUDGET_EXHAUSTED`) — both are listed
 * because the old name is still what the rate-limits page documents, and carrying two
 * strings is cheaper than being wrong on one.
 *
 * This list is only a FALLBACK. Monday's docs state that every rate-limit error
 * carries `retry_in_seconds`, so the field is the real signal and the codes cover an
 * error that omits it.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'COMPLEXITY_BUDGET_EXHAUSTED',
  'ComplexityException',
  'Concurrency limit exceeded',
  'Minute limit rate exceeded',
  'IP_RATE_LIMIT_EXCEEDED',
]);

/**
 * Refusals that a retry cannot fix inside one run. The daily budget resets at
 * midnight UTC, so sleeping on it burns the run and then fails anyway — and it may
 * still arrive WITH a `retry_in_seconds`, which is why this is checked first.
 */
const TERMINAL_CODES: ReadonlySet<string> = new Set(['DAILY_LIMIT_EXCEEDED']);

/**
 * How long to wait before retrying a transient GraphQL refusal, or `null` when the
 * error is not worth retrying.
 *
 * Recognition is by STRUCTURE — a known code, or a numeric `retry_in_seconds` — never
 * by the message text: Monday has already reworded the complexity error once, and a
 * regex over prose would have silently stopped retrying the day they did.
 */
export function transientBackoffMs(errors: readonly GraphQLError[]): number | null {
  let wait: number | null = null;
  for (const error of errors) {
    const extensions = error.extensions ?? null;
    if (extensions === null) {
      continue;
    }
    const code = typeof extensions.code === 'string' ? extensions.code : '';
    if (TERMINAL_CODES.has(code)) {
      return null;
    }
    const seconds = extensions.retry_in_seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      wait = Math.max(wait ?? 0, seconds * SECONDS_TO_MS);
    } else if (TRANSIENT_CODES.has(code)) {
      wait = Math.max(wait ?? 0, 0);
    }
  }
  return wait;
}

export function createMondayMutationClient(
  opts: MondayMutationClientOptions
): MondayMutationClient {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const complexityRetries = opts.complexityRetries ?? DEFAULT_COMPLEXITY_RETRIES;

  /** Time left before the injected deadline; Infinity when none was supplied. */
  function remainingMs(): number {
    const deadline = opts.deadlineMs?.() ?? null;
    return deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now();
  }

  /** Sleep, but never past the deadline — the next attempt then fails fast. */
  function boundedSleep(ms: number): Promise<void> {
    return sleep(Math.max(0, Math.min(ms, maxBackoffMs, remainingMs())));
  }

  /** One HTTP round trip, with transport-level retry for network errors and 5xx/429. */
  async function post(body: string, headers: Record<string, string>): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw lastError ?? new Error('Monday mutate: deadline exceeded');
      }
      const isLast = attempt === attempts - 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        // Buffer the body while the abort timer is still armed: `fetch` resolves on
        // headers, so a stalled body would otherwise outlive the timeout.
        const text = await res.text();
        const buffered = new Response(text.length > 0 ? text : null, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
        if (isLast || !RETRYABLE_STATUS.has(res.status)) {
          return buffered;
        }
        /**
         * `headers.get` returns `null` when the header is absent, and `Number(null)` is
         * `0` — which is finite and non-negative, so the obvious version treats "no
         * Retry-After" as "retry immediately" and skips the backoff entirely. Check the
         * raw header first.
         */
        const header = res.headers.get('retry-after');
        const seconds = header === null ? Number.NaN : Number(header);
        const wait =
          Number.isFinite(seconds) && seconds >= 0
            ? seconds * SECONDS_TO_MS
            : baseBackoffMs * 2 ** attempt;
        await boundedSleep(wait);
      } catch (error) {
        lastError = error;
        if (isLast) {
          throw error;
        }
        await boundedSleep(baseBackoffMs * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable: the last attempt always returns or throws.
    throw lastError ?? new Error('Monday mutate: retries exhausted');
  }

  async function mutate<T>(
    document: string,
    variables: Record<string, unknown> = {},
    mutateOpts?: MutateOptions
  ): Promise<T> {
    const body = JSON.stringify({ query: document, variables });
    const headers: Record<string, string> = {
      Authorization: opts.token,
      'Content-Type': 'application/json',
      'API-Version': opts.apiVersion,
      ...(mutateOpts?.idempotencyKey === undefined
        ? {}
        : { 'Idempotency-Key': mutateOpts.idempotencyKey }),
    };

    for (let round = 0; round <= complexityRetries; round += 1) {
      if (remainingMs() <= 0) {
        throw new Error('Monday mutate: deadline exceeded');
      }
      const res = await post(body, headers);
      if (!res.ok) {
        throw new Error(`Monday mutate ${res.status}: ${await res.text()}`);
      }

      const parsed: { data?: T; errors?: GraphQLError[] } = await res.json();
      const errors = parsed.errors ?? [];
      if (errors.length > 0) {
        const wait = transientBackoffMs(errors);
        if (wait === null || round === complexityRetries) {
          throw new Error(`Monday mutate errors: ${describe(errors)}`);
        }
        await boundedSleep(wait);
        continue;
      }
      if (parsed.data === undefined || parsed.data === null) {
        throw new Error('Monday mutate: empty data');
      }
      return parsed.data;
    }

    // Unreachable: the last round either returns or throws.
    throw new Error('Monday mutate: complexity retries exhausted');
  }

  return { mutate };
}
