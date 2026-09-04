import { describe, expect, it, vi } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { withBoardLease } from '../lease';
import { runDailyCheckExclusive } from '../run';

import { GROUPS, usage } from './helpers';

import type { KvStore } from '@lib/recommend/kv';
import type { DailyCheckDeps } from '../run';

const leaseWith = (kv: KvStore, token: string, now?: () => number) => ({
  kv,
  token: () => token,
  ...(now === undefined ? {} : { now }),
});

describe('withBoardLease', () => {
  it('draait de body en geeft de grendel daarna vrij', async () => {
    const kv = createMemoryKvStore();
    const outcome = await withBoardLease(leaseWith(kv, 't1'), 'b1', async () => 42);
    expect(outcome).toEqual({ kind: 'ran', value: 42 });
    // Vrijgegeven, dus de volgende krijgt hem gewoon.
    expect(await withBoardLease(leaseWith(kv, 't2'), 'b1', async () => 1)).toEqual({
      kind: 'ran',
      value: 1,
    });
  });

  /**
   * De kern: twee runs die elkaar overlappen lezen allebei een bord zonder melding X en maken
   * hem allebei aan. De idempotency-sleutel houdt dat niet tegen, want die bevat het run-id.
   */
  it('laat een tweede run niet binnen terwijl de eerste bezig is', async () => {
    const kv = createMemoryKvStore();
    let tweede: unknown = null;
    const eerste = await withBoardLease(leaseWith(kv, 't1'), 'b1', async () => {
      tweede = await withBoardLease(leaseWith(kv, 't2'), 'b1', async () => 'zou niet moeten');
      return 'ok';
    });
    expect(eerste).toEqual({ kind: 'ran', value: 'ok' });
    expect(tweede).toEqual({ kind: 'busy' });
  });

  it('grendelt per bord, niet globaal', async () => {
    const kv = createMemoryKvStore();
    const binnen = await withBoardLease(leaseWith(kv, 't1'), 'bord-a', async () =>
      withBoardLease(leaseWith(kv, 't2'), 'bord-b', async () => 'ander bord')
    );
    expect(binnen).toEqual({ kind: 'ran', value: { kind: 'ran', value: 'ander bord' } });
  });

  it('geeft de grendel ook vrij als de body werpt', async () => {
    const kv = createMemoryKvStore();
    await expect(
      withBoardLease(leaseWith(kv, 't1'), 'b1', async () => {
        throw new Error('stuk');
      })
    ).rejects.toThrow('stuk');
    expect(await withBoardLease(leaseWith(kv, 't2'), 'b1', async () => 1)).toEqual({
      kind: 'ran',
      value: 1,
    });
  });

  /**
   * De kern van de vrijgavecontrole, en waarom die op tijd stoelt en niet op teruglezen.
   *
   * Loopt een run over de TTL heen, dan kan een volgende de grendel al hebben. Teruglezen en
   * dan verwijderen sluit dat niet: tussen die twee stappen kan de sleutel alsnog verlopen en
   * kan een ander hem pakken, waarna wij díéns grendel weghalen en er een derde schrijver bij
   * kan. Daarom: bij een run die te lang duurde raken we hem niet aan.
   */
  it('raakt de grendel niet aan als de run te lang duurde', async () => {
    const kv = createMemoryKvStore();
    let klok = 1_000_000;
    const lease = leaseWith(kv, 'traag', () => klok);

    await withBoardLease(lease, 'b1', async () => {
      // Voorbij de helft van de TTL: vanaf hier kan de sleutel verlopen zijn.
      klok += 200_000;
      // En een ander heeft hem inderdaad overgenomen.
      await kv.set('signals:lease:b1', 'nieuwe-eigenaar');
    });

    expect(await kv.get('signals:lease:b1')).toBe('nieuwe-eigenaar');
  });

  it('geeft wél vrij als de run ruim binnen de TTL bleef', async () => {
    const kv = createMemoryKvStore();
    let klok = 1_000_000;
    const lease = leaseWith(kv, 'snel', () => klok);

    await withBoardLease(lease, 'b1', async () => {
      klok += 30_000;
    });

    // Zo kort na het pakken kan de sleutel onmogelijk verlopen zijn, dus opruimen is veilig —
    // en nodig, anders zit de volgende run vijf minuten te wachten voor niets.
    expect(await kv.get('signals:lease:b1')).toBeNull();
  });
});

describe('runDailyCheckExclusive', () => {
  const baseDeps = (writer: DailyCheckDeps['writer']): DailyCheckDeps => ({
    readSignals: async () => [],
    readAgendaUsage: async () => usage({ labels: new Map(), themas: new Map() }),
    readLabels: async () => new Map(),
    readThemas: async () => new Map(),
    readTrainers: async () => new Set(),
    writer,
    groups: GROUPS,
    now: () => new Date('2026-09-04T03:15:00.000Z'),
  });

  const noopWriter: NonNullable<DailyCheckDeps['writer']> = {
    create: async () => {},
    update: async () => {},
    reopen: async () => {},
    tick: async () => {},
    updateSummary: async () => {},
    move: async () => {},
    clearClosedBy: async () => {},
  };

  it('meldt busy als een andere run de grendel heeft', async () => {
    const kv = createMemoryKvStore();
    await kv.set('signals:lease:b1', 'iemand-anders');
    const outcome = await runDailyCheckExclusive(baseDeps(noopWriter), leaseWith(kv, 't1'), 'b1');
    expect(outcome).toEqual({ kind: 'busy' });
  });

  /**
   * Een droogloop schrijft niets, dus twee ervan kunnen elkaar niet raken — en een handmatige
   * kijk hoort de nachtelijke run niet te blokkeren, noch andersom geblokkeerd te worden.
   */
  it('grendelt niet in een droogloop', async () => {
    const kv = createMemoryKvStore();
    await kv.set('signals:lease:b1', 'de-cron-is-bezig');
    const setIfAbsent = vi.spyOn(kv, 'setIfAbsent');

    const outcome = await runDailyCheckExclusive(baseDeps(null), leaseWith(kv, 't1'), 'b1');

    expect(outcome.kind).toBe('ran');
    expect(setIfAbsent).not.toHaveBeenCalled();
  });
});
