import { afterEach, describe, expect, it, vi } from 'vitest';

import { azureOpenAIConfigFromEnv, createAzureOpenAICompletion } from '../completion';
import { runWithDeadline } from '../deadline';

/**
 * The address formatter's transport, now Azure OpenAI. Only the wiring is ours: what goes
 * out, what text comes back, and that a failure throws (the formatter maps a throw to an
 * `error` decision → FOUT, never to "no travel").
 */

const HOUR_MS = 3_600_000;
const KORT_MS = 50;

const CONFIG = {
  endpoint: 'https://itg-foundry.openai.azure.com/',
  apiKey: 'azure-test-key',
  deployment: 'address-gpt',
};

function antwoord(content: string | null, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAzureOpenAICompletion', () => {
  it('posts system and user text to the deployment and returns the answer text', async () => {
    const verzonden: { url: string; headers: Headers; body: unknown }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      verzonden.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(antwoord('{"outcome":"online"}'));
    });

    const complete = createAzureOpenAICompletion(CONFIG);
    await expect(complete({ system: 'S', user: 'U' })).resolves.toBe('{"outcome":"online"}');

    expect(verzonden).toHaveLength(1);
    expect(verzonden[0]?.url).toBe(
      'https://itg-foundry.openai.azure.com/openai/v1/chat/completions'
    );
    expect(verzonden[0]?.headers.get('api-key')).toBe('azure-test-key');
    expect(verzonden[0]?.body).toEqual(
      expect.objectContaining({
        model: 'address-gpt',
        messages: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'U' },
        ],
        // Reasoning models reject `max_tokens` and `temperature`.
        max_completion_tokens: 1024,
        reasoning_effort: 'none',
        response_format: { type: 'json_object' },
      })
    );
    expect(verzonden[0]?.body).not.toHaveProperty('max_tokens');
    expect(verzonden[0]?.body).not.toHaveProperty('temperature');
  });

  it('uses only the origin of the endpoint, whatever path was pasted with it', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(String(url));
      return Promise.resolve(antwoord('{"outcome":"online"}'));
    });
    await createAzureOpenAICompletion({
      ...CONFIG,
      endpoint: 'https://itg.services.ai.azure.com/openai/v1/responses',
    })({ system: 'S', user: 'U' });
    expect(urls).toEqual(['https://itg.services.ai.azure.com/openai/v1/chat/completions']);
  });

  it('throws when the answer has no text, so the formatter records an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(antwoord(null, 'content_filter')));
    await expect(createAzureOpenAICompletion(CONFIG)({ system: 'S', user: 'U' })).rejects.toThrow(
      'no text (finish_reason content_filter)'
    );
  });

  it('throws on a non-2xx answer without retrying a client error', async () => {
    let pogingen = 0;
    vi.stubGlobal('fetch', () => {
      pogingen += 1;
      return Promise.resolve(
        new Response('{"error":{"code":"401","message":"Access denied"}}', { status: 401 })
      );
    });
    await expect(createAzureOpenAICompletion(CONFIG)({ system: 'S', user: 'U' })).rejects.toThrow(
      'HTTP 401'
    );
    expect(pogingen).toBe(1);
  });

  it('retries a rate limit and then succeeds', async () => {
    let pogingen = 0;
    vi.stubGlobal('fetch', () => {
      pogingen += 1;
      return Promise.resolve(
        pogingen === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
          : antwoord('{"outcome":"online"}')
      );
    });
    await expect(createAzureOpenAICompletion(CONFIG)({ system: 'S', user: 'U' })).resolves.toBe(
      '{"outcome":"online"}'
    );
    expect(pogingen).toBe(2);
  });

  it('fails fast without calling out once the run deadline has passed', async () => {
    let aangeroepen = false;
    vi.stubGlobal('fetch', () => {
      aangeroepen = true;
      return Promise.resolve(antwoord('x'));
    });
    await expect(
      runWithDeadline(Date.now() - HOUR_MS, () =>
        createAzureOpenAICompletion(CONFIG)({ system: 'S', user: 'U' })
      )
    ).rejects.toThrow('deadline');
    expect(aangeroepen).toBe(false);
  });

  it('gives up on a response whose body never finishes, instead of hanging', async () => {
    let pogingen = 0;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      pogingen += 1;
      const body = new ReadableStream({
        start(controller) {
          // Headers are there, the body never comes — until the attempt is aborted.
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const complete = createAzureOpenAICompletion(CONFIG, {
      retry: { timeoutMs: KORT_MS, baseDelayMs: 1 },
    });
    await expect(complete({ system: 'S', user: 'U' })).rejects.toThrow();
    expect(pogingen).toBe(3);
  }, 30_000);
});

describe('azureOpenAIConfigFromEnv', () => {
  it('reads the three variables', () => {
    expect(
      azureOpenAIConfigFromEnv({
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_DEPLOYMENT: 'd',
      })
    ).toEqual({ endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' });
  });

  it('names every missing variable at once', () => {
    expect(() => azureOpenAIConfigFromEnv({ AZURE_OPENAI_API_KEY: 'k' })).toThrow(
      'AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT'
    );
  });
});
