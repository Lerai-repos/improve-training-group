import { describe, expect, it, vi } from 'vitest';

import { createMemoryKvStore } from '../kv';
import {
  createSubscriptionStore,
  MOVE_EVENT,
  parseCreatedWebhookId,
  parseWebhookRows,
  syncWebhooks,
  webhookIdempotencyKey,
  type WebhookRow,
  type WebhookSyncDeps,
} from '../webhook-sync';

/**
 * Elk agendabord met aanbevelingen abonneren op de groepsverplaatsing. Aanmaken mag,
 * verwijderen nooit: Monday geeft geen URL terug en n8n luistert naar hetzelfde event, dus
 * wat niet van ons is, is niet te herkennen.
 */

const GROUPS = ['group_mkwtj07a', 'nieuwe_groep'];
const AGENDA_2026 = '5087396949';

const row = (id: string, groupId: string): WebhookRow => ({
  id,
  event: MOVE_EVENT,
  config: `{"groupId" => "${groupId}"}`,
});

function harness(input: {
  boards: readonly { boardId: string; naam: string }[];
  rows?: Record<string, readonly WebhookRow[]>;
  dryRun?: boolean;
  listFails?: boolean;
}) {
  const kv = createMemoryKvStore();
  const store = createSubscriptionStore(kv);
  let next = 900;
  const createWebhook = vi.fn(async () => String((next += 1)));
  const deps: WebhookSyncDeps = {
    boards: async () => input.boards,
    triggerGroupIds: GROUPS,
    listWebhooks: async (boardId) => {
      if (input.listFails === true) {
        throw new Error('Monday down');
      }
      return input.rows?.[boardId] ?? [];
    },
    createWebhook,
    store,
    dryRun: input.dryRun ?? false,
  };
  return { deps, store, createWebhook };
}

describe('syncWebhooks', () => {
  /** Anders maakt de eerste run ze opnieuw aan, en rekent elke training op 2026 dubbel. */
  it('neemt de bestaande webhooks op Agenda 2026 over zonder iets aan te maken', async () => {
    const { deps, store, createWebhook } = harness({
      boards: [{ boardId: AGENDA_2026, naam: 'Agenda 2026' }],
      rows: {
        [AGENDA_2026]: [
          row('152998532', 'group_mkwtj07a'), // die van n8n
          row('181756731', 'group_mkwtj07a'),
          row('181756735', 'nieuwe_groep'),
        ],
      },
    });

    const uit = await syncWebhooks(deps);

    expect(createWebhook).not.toHaveBeenCalled();
    expect(uit.present.map((s) => s.webhookId)).toEqual(['181756731', '181756735']);
    expect(await store.read(AGENDA_2026, 'nieuwe_groep')).toBe('181756735');
  });

  it('abonneert een nieuw bord op beide groepen en onthoudt de ids', async () => {
    const { deps, store, createWebhook } = harness({
      boards: [{ boardId: '6000000001', naam: 'Agenda 2027' }],
    });

    const uit = await syncWebhooks(deps);

    expect(createWebhook.mock.calls).toEqual([
      ['6000000001', 'group_mkwtj07a', null],
      ['6000000001', 'nieuwe_groep', null],
    ]);
    expect(uit.created).toHaveLength(2);
    expect(await store.read('6000000001', 'group_mkwtj07a')).toBe('901');
  });

  it('maakt niets opnieuw aan zolang het onthouden id er nog staat', async () => {
    const { deps, store, createWebhook } = harness({
      boards: [{ boardId: '6000000001', naam: 'Agenda 2027' }],
      rows: { '6000000001': [row('11', 'group_mkwtj07a'), row('12', 'nieuwe_groep')] },
    });
    await store.write('6000000001', 'group_mkwtj07a', '11');
    await store.write('6000000001', 'nieuwe_groep', '12');

    await syncWebhooks(deps);

    expect(createWebhook).not.toHaveBeenCalled();
  });

  it('maakt een webhook opnieuw aan als iemand hem heeft verwijderd', async () => {
    const { deps, store, createWebhook } = harness({
      boards: [{ boardId: '6000000001', naam: 'Agenda 2027' }],
      rows: { '6000000001': [row('12', 'nieuwe_groep')] },
    });
    await store.write('6000000001', 'group_mkwtj07a', '11');
    await store.write('6000000001', 'nieuwe_groep', '12');

    await syncWebhooks(deps);

    // Met het verdwenen id erbij, zodat de idempotency-sleutel een nieuwe is.
    expect(createWebhook.mock.calls).toEqual([['6000000001', 'group_mkwtj07a', '11']]);
  });

  it('maakt in een droogloop niets aan en onthoudt niets', async () => {
    const { deps, store, createWebhook } = harness({
      boards: [{ boardId: '6000000001', naam: 'Agenda 2027' }],
      dryRun: true,
    });

    const uit = await syncWebhooks(deps);

    expect(createWebhook).not.toHaveBeenCalled();
    expect(uit.created).toHaveLength(2);
    expect(await store.read('6000000001', 'group_mkwtj07a')).toBeNull();
  });

  /** Zonder de lijst is niet te zien wat er staat; aanmaken zou blind dubbelen. */
  it('maakt niets aan als de webhooks van een bord niet te lezen zijn', async () => {
    const { deps, createWebhook } = harness({
      boards: [{ boardId: '6000000001', naam: 'Agenda 2027' }],
      listFails: true,
    });

    const uit = await syncWebhooks(deps);

    expect(createWebhook).not.toHaveBeenCalled();
    expect(uit.failed).toHaveLength(2);
  });
});

describe('parseWebhookRows', () => {
  it('leest de rijen en weigert een antwoord zonder lijst', () => {
    expect(
      parseWebhookRows({ webhooks: [{ id: 181756731, event: MOVE_EVENT, config: null }] })
    ).toEqual([{ id: '181756731', event: MOVE_EVENT, config: null }]);
    expect(() => parseWebhookRows({})).toThrow(/webhooks/);
  });
});

describe('parseCreatedWebhookId', () => {
  it('leest het id, en weigert een antwoord zonder id', () => {
    expect(parseCreatedWebhookId({ create_webhook: { id: '5' } })).toBe('5');
    expect(() => parseCreatedWebhookId({ create_webhook: null })).toThrow(/geen id/);
  });
});

describe('webhookIdempotencyKey', () => {
  /** Een herhaalde aanmaak na een verloren antwoord mag geen tweede webhook opleveren. */
  it('is gelijk voor een herhaling van dezelfde poging', () => {
    expect(webhookIdempotencyKey('1', 'g', null)).toBe(webhookIdempotencyKey('1', 'g', null));
  });

  /** Anders geeft Monday binnen 30 minuten het oude, verwijderde id terug. */
  it('verschilt wanneer een verwijderde webhook opnieuw wordt aangemaakt', () => {
    expect(webhookIdempotencyKey('1', 'g', '11')).not.toBe(webhookIdempotencyKey('1', 'g', null));
  });
});
