import { z } from 'zod';

import { ADDRESS_MODEL, type Completion } from './address';
import { fetchWithRetry } from './http';

/**
 * OpenRouter chat-completion transport for the address formatter (Claude Haiku,
 * matching the legacy flow-6). Transient failures (429/5xx/network) are retried
 * with backoff; a persistent non-2xx or an unparseable response throws — the
 * formatter maps that to an `error` decision (→ FOUT), never no-travel.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export function createOpenRouterCompletion(
  apiKey: string,
  model: string = ADDRESS_MODEL
): Completion {
  return async ({ system, user }): Promise<string> => {
    const res = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }
    const parsed = responseSchema.parse(await res.json());
    return parsed.choices[0].message.content;
  };
}
