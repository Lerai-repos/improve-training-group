import { describe, expect, it, vi } from 'vitest';

import { applyActions, createSignalWriter, dutchDate, resolvedNote } from '../write';

import type { MondayMutationClient } from '@lib/monday/mutate';
import { rowForFinding } from '../text';

import { signal } from './helpers';

import type { ExistingSignal, SignalAction } from '../reconcile';
import type { Finding } from '../types';

const NOW = new Date('2026-09-04T03:15:00.000Z');

function fakeClient(): {
  client: MondayMutationClient;
  calls: Array<{
    document: string;
    variables: Record<string, unknown>;
    opts?: { idempotencyKey?: string };
  }>;
} {
  const calls: Array<{
    document: string;
    variables: Record<string, unknown>;
    opts?: { idempotencyKey?: string };
  }> = [];
  const mutate = vi.fn(
    async (
      document: string,
      variables: Record<string, unknown> = {},
      opts?: { idempotencyKey?: string }
    ): Promise<never> => {
      calls.push({ document, variables, opts });
      // De aanroepers gebruiken de uitkomst niet; een leeg object volstaat.
      return undefined as never;
    }
  );
  return { client: { mutate }, calls };
}

const values = (call: { variables: Record<string, unknown> }): Record<string, unknown> => {
  const raw = call.variables.values;
  if (typeof raw !== 'string') {
    throw new Error('column_values hoort een JSON-string te zijn');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('column_values hoort een object te zijn');
  }
  return { ...parsed };
};

describe('dutchDate', () => {
  it('schrijft zonder voorloopnullen, zoals iemand het zou typen', () => {
    expect(dutchDate(NOW)).toBe('4-9-2026');
  });
});

describe('createSignalWriter', () => {
  it('stuurt de sleutel MEE met de create, niet erna', () => {
    // Een rij die even zonder sleutel bestaat wordt door een gelijktijdige run genegeerd, en
    // dan staat hij er twee keer.
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    return writer
      .create({
        naam: 'Label "TMT" is niet ingesteld',
        soort: 'Signalering',
        onderdeel: 'Labelconfiguratie',
        detail: 'uitleg',
        sleutel: 'onbekend-label:TMT',
        groupId: 'g_open',
      })
      .then(() => {
        expect(calls).toHaveLength(1);
        expect(calls[0]?.document).toContain('create_item');
        expect(calls[0]?.variables.group).toBe('g_open');
        expect(values(calls[0]!)).toMatchObject({
          itg_sleutel: 'onbekend-label:TMT',
          itg_soort: { label: 'Signalering' },
          itg_onderdeel: 'Labelconfiguratie',
          itg_detail: 'uitleg',
          itg_tijdstip: { date: '2026-09-04', time: '03:15:00' },
        });
      });
  });

  it('zet bij het afvinken de opgelost-regel BOVEN het bestaande detail', async () => {
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    const rij: ExistingSignal = signal({ itemId: 'i7', detail: 'de oorspronkelijke uitleg' });

    await writer.tick(rij);

    const written = values(calls[0]!);
    expect(written.itg_afgehandeld).toEqual({ checked: 'true' });
    expect(String(written.itg_detail)).toBe(`${resolvedNote(NOW)}\n\nde oorspronkelijke uitleg`);
    expect(String(written.itg_detail).startsWith('Opgelost op 4-9-2026')).toBe(true);
  });
});

describe('applyActions', () => {
  const finding: Finding = { kind: 'onbekend-label', label: 'TMT', trainingen: 7 };
  const rij: ExistingSignal = signal({ itemId: 'i7', key: 'thema-zonder-inhoud:12' });

  it('telt wat er is aangemaakt en wat er is afgevinkt', async () => {
    const created: string[] = [];
    const ticked: string[] = [];
    const actions: readonly SignalAction[] = [
      { kind: 'create', row: rowForFinding(finding) },
      { kind: 'resolve', signal: rij },
    ];

    const result = await applyActions(
      {
        create: async (f) => {
          created.push(f.sleutel);
        },
        tick: async (s) => {
          ticked.push(s.itemId);
        },
        update: async () => {},
        reopen: async () => {},
        updateSummary: async () => {},
        move: async () => {},
        clearClosedBy: async () => {},
      },
      actions,
      'g_open'
    );

    expect(result).toEqual({
      created: 1,
      updated: 0,
      resolved: 1,
      reopened: 0,
      resolvedIds: ['i7'],
      reopenedIds: [],
    });
    expect(created).toEqual(['onbekend-label:TMT']);
    expect(ticked).toEqual(['i7']);
  });

  it('geeft de gerenderde naam en het detail door, niet de rauwe vondst', async () => {
    let naam = '';
    let detail = '';
    await applyActions(
      {
        create: async (f) => {
          naam = f.naam;
          detail = f.detail;
        },
        tick: async () => {},
        update: async () => {},
        reopen: async () => {},
        updateSummary: async () => {},
        move: async () => {},
        clearClosedBy: async () => {},
      },
      [{ kind: 'create', row: rowForFinding(finding) }],
      'g_open'
    );
    expect(naam).toBe('Label "TMT" is niet ingesteld — 7 trainingen');
    expect(detail).toContain('vink dit item dan af');
  });
});

describe('createSignalWriter — idempotentie', () => {
  /**
   * De transportlaag doet een tweede poging bij een netwerkfout en bij 429/5xx. Komt de create
   * wél aan maar gaat het antwoord verloren, dan levert die tweede poging een tweede rij op —
   * en de sleutelkolom kan dat niet opvangen, want tussen twee pogingen wordt er niets
   * teruggelezen.
   */
  it('geeft een create een idempotency-sleutel mee', async () => {
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    await writer.create({
      naam: 'n',
      soort: 'Signalering',
      onderdeel: 'o',
      detail: 'd',
      sleutel: 'onbekend-label:TMT',
      groupId: 'g_open',
    });
    expect(calls[0]?.opts?.idempotencyKey).toMatch(/^signal:b1:r1:create:[0-9a-f]{32}$/);
  });

  it('houdt de sleutel per bord uit elkaar', async () => {
    // Monday cachet een sleutel 30 minuten. Zonder het bord-id zou een testbord het antwoord
    // van productie terug kunnen krijgen — dezelfde val als in `instellingen-create`.
    const a = fakeClient();
    const b = fakeClient();
    const velden = {
      naam: 'n',
      soort: 'Signalering' as const,
      onderdeel: 'o',
      detail: 'd',
      sleutel: 'onbekend-label:TMT',
      groupId: 'g',
    };
    await createSignalWriter(a.client, 'bord-a', 'r1', () => NOW).create(velden);
    await createSignalWriter(b.client, 'bord-b', 'r1', () => NOW).create(velden);
    expect(a.calls[0]?.opts?.idempotencyKey).not.toBe(b.calls[0]?.opts?.idempotencyKey);
  });

  it('maakt de sleutel headerveilig', async () => {
    // De sleutel reist als HTTP-header. Een labelwaarde uit Monday mag alles bevatten, en een
    // `é` laat `fetch` zelf struikelen — dan mislukt de mutatie op zijn eigen beveiliging.
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    await writer.create({
      naam: 'n',
      soort: 'Signalering',
      onderdeel: 'o',
      detail: 'd',
      sleutel: 'onbekend-label:Café — StressTrainer',
      groupId: 'g',
    });
    expect(calls[0]?.opts?.idempotencyKey ?? '').toMatch(/^[A-Za-z0-9:_.-]+$/);
  });

  /**
   * De reden dat dit een digest is en geen tekenvervanging.
   *
   * Zouden onveilige tekens `_` worden, dan vallen deze twee labels samen. Monday geeft dan
   * binnen dertig minuten het eerste antwoord terug op de tweede create, en die tweede melding
   * verschijnt nooit — zonder fout, zonder spoor.
   */
  it.each([
    ['onbekend-label:A/B', 'onbekend-label:A B'],
    ['onbekend-label:A-B', 'onbekend-label:A.B'],
    [`onbekend-label:${'x'.repeat(200)}1`, `onbekend-label:${'x'.repeat(200)}2`],
  ])('geeft %s en %s verschillende sleutels', async (een, twee) => {
    const keys: string[] = [];
    for (const sleutel of [een, twee]) {
      const { client, calls } = fakeClient();
      await createSignalWriter(client, 'b1', 'r1', () => NOW).create({
        naam: 'n',
        soort: 'Signalering',
        onderdeel: 'o',
        detail: 'd',
        sleutel,
        groupId: 'g',
      });
      keys.push(calls[0]?.opts?.idempotencyKey ?? '');
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('geeft dezelfde melding binnen één run steeds dezelfde sleutel', async () => {
    // Dat is het hele punt: een herhaalde poging na een verloren antwoord moet als dezelfde
    // create herkend worden.
    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { client, calls } = fakeClient();
      await createSignalWriter(client, 'b1', 'r1', () => NOW).create({
        naam: 'n',
        soort: 'Signalering',
        onderdeel: 'o',
        detail: 'd',
        sleutel: 'onbekend-label:TMT',
        groupId: 'g',
      });
      keys.push(calls[0]?.opts?.idempotencyKey ?? '');
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it('geeft een toewijzing GEEN sleutel — die is uit zichzelf al idempotent', async () => {
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    await writer.tick(signal({ itemId: 'i7' }));
    await writer.update('i7', { naam: 'n', detail: 'd' });
    await writer.move({ itemId: 'i7', groupId: 'g', from: 'h' });
    expect(calls.map((c) => c.opts?.idempotencyKey)).toEqual([undefined, undefined, undefined]);
  });
});

describe('createSignalWriter — heropenen', () => {
  it('haalt het vinkje eruit en maakt Afgehandeld door leeg', async () => {
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    await writer.reopen('i7', { naam: 'nieuwe naam', detail: 'nieuw detail' });

    const written = values(calls[0]!);
    expect(written.itg_afgehandeld).toEqual({ checked: 'false' });
    // Leeg, zodat wie hem hierna afvinkt weer als mens telt.
    expect(written.itg_afgehandeld_door).toBe('');
    expect(written.name).toBe('nieuwe naam');
  });

  it('schrijft bij afvinken wie het deed', async () => {
    const { client, calls } = fakeClient();
    const writer = createSignalWriter(client, 'b1', 'r1', () => NOW);
    await writer.tick(signal({ itemId: 'i7' }));
    expect(values(calls[0]!).itg_afgehandeld_door).toBe('controle');
  });
});
