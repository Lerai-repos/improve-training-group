import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { verwerkEvalKnopWebhook } from '../knop-webhook';

import type { EvalKnopWebhook } from '../knop';

const run = (triggerUuid: string | null = 'abc'): EvalKnopWebhook => ({
  kind: 'run',
  itemId: '1',
  boardId: '2',
  triggerUuid,
});

function harness() {
  const gestart: Array<[string, string]> = [];
  const kv = createMemoryKvStore();
  const start = (itemId: string, boardId: string): void => {
    gestart.push([itemId, boardId]);
  };
  return { kv: () => kv, gestart, start };
}

describe('verwerkEvalKnopWebhook', () => {
  it('beantwoordt de challenge zonder iets te starten', async () => {
    const h = harness();
    const antwoord = await verwerkEvalKnopWebhook({ kind: 'challenge', challenge: 'x' }, h);
    expect(antwoord).toEqual({ status: 200, body: { challenge: 'x' } });
    expect(h.gestart).toEqual([]);
  });

  it('negeert met 200, zodat Monday niet opnieuw aflevert', async () => {
    const h = harness();
    const antwoord = await verwerkEvalKnopWebhook({ kind: 'negeren', reden: 'andere kolom' }, h);
    expect(antwoord).toEqual({ status: 200, body: { genegeerd: 'andere kolom' } });
    expect(h.gestart).toEqual([]);
  });

  it('start de verwerking en antwoordt meteen', async () => {
    const h = harness();
    const antwoord = await verwerkEvalKnopWebhook(run(), h);
    expect(antwoord).toEqual({ status: 200, body: { gestart: '1' } });
    expect(h.gestart).toEqual([['1', '2']]);
  });

  /**
   * Monday levert een webhook soms twee keer af. De knop stuurt altijd, dus zonder deze
   * grendel gaan de mails dan twee keer de deur uit.
   */
  it('verwerkt hetzelfde event maar één keer', async () => {
    const h = harness();
    await verwerkEvalKnopWebhook(run('abc'), h);
    const tweede = await verwerkEvalKnopWebhook(run('abc'), h);
    expect(tweede).toEqual({ status: 200, body: { genegeerd: 'al verwerkt' } });
    expect(h.gestart).toHaveLength(1);
  });

  it('verwerkt een nieuwe knopdruk op dezelfde training wél', async () => {
    const h = harness();
    await verwerkEvalKnopWebhook(run('abc'), h);
    await verwerkEvalKnopWebhook(run('def'), h);
    expect(h.gestart).toHaveLength(2);
  });

  it('start ook zonder triggerUuid', async () => {
    const h = harness();
    await verwerkEvalKnopWebhook(run(null), h);
    await verwerkEvalKnopWebhook(run(null), h);
    expect(h.gestart).toHaveLength(2);
  });
});
