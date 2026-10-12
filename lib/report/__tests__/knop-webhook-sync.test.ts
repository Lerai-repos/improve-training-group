import { describe, expect, it } from 'vitest';

import { syncEvalKnopWebhooks, teVerwijderen } from '../knop-webhook-sync';

import type { KnopWebhookSyncDeps } from '../knop-webhook-sync';

/** Zo geeft Monday `config` terug: een Ruby-hash als tekst. Gemeten op Agenda 2026. */
const N8N = {
  id: '157401136',
  event: 'change_status_column_value',
  config:
    '{"columnId" => {"boardId" => 5087396949, "columnId" => "color_mm0v53mp", "columnType" => ' +
    '"color", "isSubitemColumn" => false}, "columnValue" => {"index" => 1}}',
};
const TRAINER_STATUS = {
  id: '154679354',
  event: 'change_status_column_value',
  config:
    '{"columnId" => {"boardId" => 5087396949, "columnId" => "color_mm088qpd", "columnType" => ' +
    '"color", "isSubitemColumn" => false}, "columnValue" => {"index" => 1}}',
};
const GROEP = { id: '181756731', event: 'item_moved_to_specific_group', config: null };

describe('teVerwijderen', () => {
  it('haalt de oude Eval Status-webhook weg en laat de nieuwe staan', () => {
    const nieuw = { ...N8N, id: '999' };
    expect(teVerwijderen([N8N, nieuw, TRAINER_STATUS, GROEP], '999')).toEqual(['157401136']);
  });

  /** Andere webhooks op het bord zijn van Make.com of van onze aanbevelingen: niet aankomen. */
  it('raakt webhooks op andere kolommen en events niet aan', () => {
    expect(teVerwijderen([TRAINER_STATUS, GROEP], '999')).toEqual([]);
  });

  it('herkent een webhook zonder config niet als Eval Status', () => {
    expect(teVerwijderen([{ ...N8N, config: null }], '999')).toEqual([]);
  });
});

/**
 * Elk uur: elk actief agendabord met Eval Status krijgt onze webhook, zodat de knop op een
 * nieuwe jaargang vanzelf werkt. Zelfde regels als de aanbevelingswebhooks.
 */
describe('syncEvalKnopWebhooks', () => {
  const ONS = (id: string) => ({ ...N8N, id });

  function harness(over: Partial<KnopWebhookSyncDeps> = {}) {
    const opgeslagen = new Map<string, string>();
    const aangemaakt: Array<{ boardId: string; replaces: string | null }> = [];
    let volgend = 500;
    const deps: KnopWebhookSyncDeps = {
      boards: async () => [{ boardId: '6000000001', naam: 'Agenda 2027' }],
      listWebhooks: async () => [N8N],
      createWebhook: async (boardId, replaces) => {
        aangemaakt.push({ boardId, replaces });
        volgend += 1;
        return String(volgend);
      },
      store: {
        read: async (boardId) => opgeslagen.get(boardId) ?? null,
        write: async (boardId, id) => void opgeslagen.set(boardId, id),
      },
      dryRun: false,
      ...over,
    };
    return { deps, opgeslagen, aangemaakt };
  }

  /** De webhook van n8n telt niet mee: die is niet van ons, en n8n staat uit. */
  it('sluit een nieuw bord aan, ook als er een vreemde Eval Status-webhook staat', async () => {
    const h = harness();
    const report = await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([{ boardId: '6000000001', replaces: null }]);
    expect(h.opgeslagen.get('6000000001')).toBe('501');
    expect(report.created.map((s) => s.boardId)).toEqual(['6000000001']);
  });

  it('laat een bord met onze webhook met rust', async () => {
    const h = harness({ listWebhooks: async () => [N8N, ONS('42')] });
    h.opgeslagen.set('6000000001', '42');
    const report = await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([]);
    expect(report.present.map((s) => s.webhookId)).toEqual(['42']);
  });

  /** Op 2026 staat hij al, met de hand aangemaakt met `eval:knop-webhook --apply`. */
  it('neemt de bestaande webhook op Agenda 2026 over zonder er een bij te maken', async () => {
    const h = harness({
      boards: async () => [{ boardId: '5087396949', naam: 'Agenda 2026' }],
      listWebhooks: async () => [N8N, ONS('188884618')],
    });
    await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([]);
    expect(h.opgeslagen.get('5087396949')).toBe('188884618');
  });

  it('maakt hem opnieuw aan als de onthouden webhook verdwenen is', async () => {
    const h = harness();
    h.opgeslagen.set('6000000001', '42');
    await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([{ boardId: '6000000001', replaces: '42' }]);
  });

  it('maakt in een droogloop niets aan', async () => {
    const h = harness({ dryRun: true });
    const report = await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([]);
    expect(report.created).toHaveLength(1);
  });

  /** Zonder de lijst weten we niet wat er staat; aanmaken zou blind dubbelen. */
  it('maakt niets aan als de webhooks niet te lezen zijn', async () => {
    const h = harness({
      listWebhooks: async () => {
        throw new Error('Monday weg');
      },
    });
    const report = await syncEvalKnopWebhooks(h.deps);
    expect(h.aangemaakt).toEqual([]);
    expect(report.failed.map((f) => f.error)).toEqual(['Monday weg']);
  });

  it('gaat door naar het volgende bord als er één mislukt', async () => {
    const h = harness({
      boards: async () => [
        { boardId: '1', naam: 'A' },
        { boardId: '2', naam: 'B' },
      ],
      createWebhook: async (boardId) => {
        if (boardId === '1') {
          throw new Error('challenge mislukt');
        }
        return '9';
      },
    });
    const report = await syncEvalKnopWebhooks(h.deps);
    expect(report.failed.map((f) => f.boardId)).toEqual(['1']);
    expect(report.created.map((f) => f.boardId)).toEqual(['2']);
  });
});
