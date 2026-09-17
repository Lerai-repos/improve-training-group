import Anthropic from '@anthropic-ai/sdk';

import { ADDRESS_MODEL, type Completion } from './address';
import { currentDeadlineMs } from './deadline';

/**
 * Anthropic transport for the address formatter (Claude Haiku, matching the legacy
 * flow-6). The SDK retries transient failures (429/5xx/network) itself; a persistent
 * error or an answer without text throws — the formatter maps that to an `error`
 * decision (→ FOUT), never no-travel.
 */

// A classification answer is one small JSON object.
const MAX_TOKENS = 1024;
// Per-attempt ceiling, the same as `fetchWithRetry`: a hung connection must abort so the
// run reaches a diagnosable FOUT instead of being killed by the route.
const ATTEMPT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

export interface AnthropicCompletionOptions {
  readonly model?: string;
  /** Tests pass their own; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly attemptTimeoutMs?: number;
}

/**
 * One attempt, body included, under one timer.
 *
 * The SDK's `timeout` stops counting once the headers arrive, and only then reads the JSON
 * body — so a server that stalls the body would hang past every ceiling we set. Buffering
 * the body here, while this timer is still armed, is what `fetchWithRetry` does for the
 * other providers. Outside `runWithDeadline` (the briefing generator, the CLI scripts) this
 * is the only bound there is.
 */
function withBodyTimeout(base: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timer]) : timer;
    const res = await base(input, { ...init, signal });
    const body = await res.text();
    return new Response(body.length > 0 ? body : null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

export function createAnthropicCompletion(
  apiKey: string,
  options: AnthropicCompletionOptions = {}
): Completion {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const client = new Anthropic({
    apiKey,
    maxRetries: MAX_RETRIES,
    timeout: attemptTimeoutMs,
    fetch: withBodyTimeout(options.fetch ?? fetch, attemptTimeoutMs),
  });
  const model = options.model ?? ADDRESS_MODEL;

  return async ({ system, user }): Promise<string> => {
    /**
     * The run-scoped deadline caps the whole call, retries included. The per-attempt timer
     * above does not: three slow attempts could otherwise overrun it.
     */
    const deadlineMs = currentDeadlineMs();
    const remaining = deadlineMs === null ? null : deadlineMs - Date.now();
    if (remaining !== null && remaining <= 0) {
      throw new Error('anthropic completion: run deadline exceeded');
    }

    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      },
      remaining === null ? undefined : { signal: AbortSignal.timeout(remaining) }
    );

    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    if (text === '') {
      throw new Error(`anthropic completion: no text (stop_reason ${response.stop_reason})`);
    }
    return text;
  };
}
