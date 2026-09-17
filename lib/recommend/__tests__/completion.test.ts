import { describe, expect, it } from 'vitest';

import { createAnthropicCompletion } from '../completion';
import { runWithDeadline } from '../deadline';

/**
 * The address formatter's transport. Only the wiring is ours: what goes out, what text
 * comes back, and that a run past its deadline never calls out at all.
 */

const HOUR_MS = 3_600_000;
const KORT_MS = 50;

function antwoord(content: unknown[]): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('createAnthropicCompletion', () => {
  it('sends Haiku the system and user text and returns the answer text', async () => {
    const verzonden: unknown[] = [];
    const complete = createAnthropicCompletion('sk-test', {
      fetch: (_url, init) => {
        verzonden.push(JSON.parse(String(init?.body)));
        return Promise.resolve(antwoord([{ type: 'text', text: '{"outcome":"online"}' }]));
      },
    });

    await expect(complete({ system: 'S', user: 'U' })).resolves.toBe('{"outcome":"online"}');
    expect(verzonden).toEqual([
      expect.objectContaining({
        model: 'claude-haiku-4-5',
        system: 'S',
        messages: [{ role: 'user', content: 'U' }],
      }),
    ]);
  });

  it('throws when the answer has no text, so the formatter records an error', async () => {
    const complete = createAnthropicCompletion('sk-test', {
      fetch: () => Promise.resolve(antwoord([])),
    });
    await expect(complete({ system: 'S', user: 'U' })).rejects.toThrow('no text');
  });

  it('fails fast without calling out once the run deadline has passed', async () => {
    let aangeroepen = false;
    const complete = createAnthropicCompletion('sk-test', {
      fetch: () => {
        aangeroepen = true;
        return Promise.resolve(antwoord([{ type: 'text', text: 'x' }]));
      },
    });
    await expect(
      runWithDeadline(Date.now() - HOUR_MS, () => complete({ system: 'S', user: 'U' }))
    ).rejects.toThrow('deadline');
    expect(aangeroepen).toBe(false);
  });

  it('gives up on a response whose body never finishes, instead of hanging', async () => {
    let pogingen = 0;
    const complete = createAnthropicCompletion('sk-test', {
      attemptTimeoutMs: KORT_MS,
      fetch: (_url, init) => {
        pogingen += 1;
        const body = new ReadableStream({
          start(controller) {
            // Headers are there, the body never comes — until the attempt is aborted.
            init?.signal?.addEventListener('abort', () => {
              controller.error(init.signal?.reason);
            });
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        );
      },
    });

    await expect(complete({ system: 'S', user: 'U' })).rejects.toThrow();
    // One attempt plus the SDK's two retries, each cut off by the timer.
    expect(pogingen).toBe(3);
  }, 30_000);
});
