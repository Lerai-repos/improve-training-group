import { z } from 'zod';

import { fetchWithRetry, type RetryOptions } from './http';

import type { Completion } from './address';

/**
 * Azure OpenAI transport for the address formatter.
 *
 * Tim, 30-Sep-2026: off Anthropic and onto Azure, so the only LLM call in the app runs under
 * Microsoft's product terms (no training on prompts) in an EU data zone. Deployed in Sweden
 * Central with deployment type **Data Zone EU** — the model is in `ADDRESS_MODEL`.
 *
 * Written for the reasoning models (GPT-5.x, GPT-6). They reject `max_tokens` and, apart from
 * a few, `temperature`; they take `max_completion_tokens` and `reasoning_effort` instead.
 * `none` turns the thinking off: this is a classification, and thinking only adds latency and
 * output tokens (reasoning is billed as output).
 *
 * Plain `fetch` through `fetchWithRetry`, like the Google transport: it already owns the
 * per-attempt timer (body included), the 429/5xx retries with `Retry-After`, and the
 * run-scoped deadline. A persistent error or an answer without text throws — the formatter
 * maps that to an `error` decision (→ FOUT), never to "no travel".
 */

/**
 * The `v1` API: no dated `api-version` to keep bumping, and the path every current model is
 * documented against. The deployment name goes in `model`.
 */
const API_PATH = '/openai/v1/chat/completions';

// A classification answer is one small JSON object.
const MAX_TOKENS = 1024;
/** How much of an error body goes into the message: enough to diagnose, never a wall. */
const ERROR_BODY_CHARS = 300;

export interface AzureOpenAIConfig {
  /**
   * The resource endpoint. Only the origin is used: Foundry shows it in several forms
   * (`https://<resource>.openai.azure.com`, `https://<resource>.services.ai.azure.com/openai/v1/
   * responses`), and whatever path is pasted along would otherwise end up in front of ours.
   */
  readonly endpoint: string;
  readonly apiKey: string;
  /** The deployment NAME in Foundry, not the model name. */
  readonly deployment: string;
}

const ENV = {
  endpoint: 'AZURE_OPENAI_ENDPOINT',
  apiKey: 'AZURE_OPENAI_API_KEY',
  deployment: 'AZURE_OPENAI_DEPLOYMENT',
} as const;

/** The names, for a caller that only wants to know whether the LLM is configured. */
export const AZURE_OPENAI_ENV_VARS: readonly string[] = Object.values(ENV);

/** Throws naming every missing variable, so a half-configured deploy says what to add. */
export function azureOpenAIConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): AzureOpenAIConfig {
  const value = (name: string): string => (env[name] ?? '').trim();
  const missend = AZURE_OPENAI_ENV_VARS.filter((name) => value(name) === '');
  if (missend.length > 0) {
    throw new Error(`Azure OpenAI is not configured: ${missend.join(', ')} missing`);
  }
  return {
    endpoint: value(ENV.endpoint),
    apiKey: value(ENV.apiKey),
    deployment: value(ENV.deployment),
  };
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      })
    )
    .min(1),
});

export interface AzureCompletionOptions {
  /** Tests shorten the timers; production uses `fetchWithRetry`'s defaults. */
  readonly retry?: RetryOptions;
}

export function createAzureOpenAICompletion(
  config: AzureOpenAIConfig,
  options: AzureCompletionOptions = {}
): Completion {
  const url = `${new URL(config.endpoint).origin}${API_PATH}`;

  return async ({ system, user }): Promise<string> => {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': config.apiKey },
        body: JSON.stringify({
          model: config.deployment,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: MAX_TOKENS,
          reasoning_effort: 'none',
          // The prompt already asks for "ONLY a JSON object"; this makes the model keep to it.
          response_format: { type: 'json_object' },
        }),
      },
      options.retry
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, ERROR_BODY_CHARS);
      throw new Error(`azure openai completion: HTTP ${res.status} ${body}`);
    }
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error('azure openai completion: unreadable response');
    }
    const [choice] = parsed.data.choices;
    const text = choice?.message?.content ?? '';
    if (text === '') {
      throw new Error(
        `azure openai completion: no text (finish_reason ${choice?.finish_reason ?? 'none'})`
      );
    }
    return text;
  };
}
