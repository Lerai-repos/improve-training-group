import { describe, expect, it } from 'vitest';

import { createFailureStore, MAX_FAILURES } from '../failure-store';

import type { KvStore, TtlState } from '@lib/recommend/kv';
import type { MailFailure } from '../failure-store';

function fakeKv(): {
  kv: KvStore;
  keys: Map<string, string>;
  index: Map<string, number>;
  ttls: Map<string, number>;
} {
  const keys = new Map<string, string>();
  const ttls = new Map<string, number>();
  /**
   * Per SLEUTEL een eigen verzameling.
   *
   * Eén gedeelde map zou de namespace-tests groen laten kleuren om de verkeerde reden: dan
   * deelt productie zijn index met een test, en dat is precies wat hier bewaakt wordt.
   */
  const indexen = new Map<string, Map<string, number>>();
  const indexFor = (k: string): Map<string, number> => {
    const bestaand = indexen.get(k);
    if (bestaand !== undefined) {
      return bestaand;
    }
    const vers = new Map<string, number>();
    indexen.set(k, vers);
    return vers;
  };
  const index = indexFor('evalmail:failed:index');
  const afwezig: TtlState = { kind: 'absent' };
  const kv: KvStore = {
    get: async (k) => keys.get(k) ?? null,
    mget: async (ks) => ks.map((k) => keys.get(k) ?? null),
    set: async (k, v, opts) => {
      keys.set(k, v);
      if (opts?.ttlMs !== undefined) {
        ttls.set(k, opts.ttlMs);
      }
    },
    setIfAbsent: async (k, v) => {
      if (keys.has(k)) {
        return false;
      }
      keys.set(k, v);
      return true;
    },
    del: async (k) => {
      keys.delete(k);
    },
    incr: async () => 1,
    ttl: async () => afwezig,
    zadd: async (k, score, member) => {
      indexFor(k).set(member, score);
    },
    zrem: async (k, member) => {
      indexFor(k).delete(member);
    },
    zRangeByScore: async (k, maxScore, limit) =>
      [...indexFor(k).entries()]
        .filter(([, score]) => score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member),
  };
  return { kv, keys, index, ttls };
}

const failure = (over: Partial<MailFailure> = {}): MailFailure => ({
  itemId: 'i1',
  variant: 'met',
  klanttitel: 'Onderhandelen',
  datum: '2026-09-03',
  reden: 'fetch failed',
  atMs: 1,
  ...over,
});

describe('createFailureStore', () => {
  it('geeft terug wat er is achtergelaten', async () => {
    const store = createFailureStore(fakeKv().kv, '', () => 10);
    await store.record(failure());
    expect(await store.list()).toEqual([failure()]);
  });

  it('houdt de twee varianten van één training uit elkaar', async () => {
    // Eerst mislukt de zonder-mail; komen de reacties later, dan kan ook de met-mail mislukken.
    const store = createFailureStore(fakeKv().kv, '', () => 10);
    await store.record(failure({ variant: 'zonder' }));
    await store.record(failure({ variant: 'met', atMs: 2 }));
    expect((await store.list()).map((f) => f.variant)).toEqual(['zonder', 'met']);
  });

  it('haalt een melding weg zodra hij is opgelost', async () => {
    const store = createFailureStore(fakeKv().kv, '', () => 10);
    await store.record(failure());
    await store.clear('i1', 'met');
    expect(await store.list()).toEqual([]);
  });

  it('raakt de andere variant niet aan bij het opruimen', async () => {
    const store = createFailureStore(fakeKv().kv, '', () => 10);
    await store.record(failure({ variant: 'zonder' }));
    await store.record(failure({ variant: 'met', atMs: 2 }));
    await store.clear('i1', 'met');
    expect((await store.list()).map((f) => f.variant)).toEqual(['zonder']);
  });

  /**
   * Er stond eerst een TTL van dertig dagen op de details. Verliep die, dan verdween de melding
   * en verzoende de dagelijkse controle hem weg als opgelost — over een mail die nooit
   * verstuurd was. Een vergissing die pas na een maand zichtbaar wordt en er dan uitziet als
   * "het is opgelost".
   */
  it('legt geen vervaltijd op de details', async () => {
    const { kv, ttls } = fakeKv();
    await createFailureStore(kv, '', () => 10).record(failure());
    expect([...ttls.values()]).toEqual([]);
  });

  it('houdt de melding overeind als de details tóch weg zijn', async () => {
    const { kv, keys } = fakeKv();
    const store = createFailureStore(kv, '', () => 10);
    await store.record(failure());
    keys.clear();

    const lijst = await store.list();
    expect(lijst).toHaveLength(1);
    expect(lijst[0]).toMatchObject({ itemId: 'i1', variant: 'met' });
  });

  it('houdt de melding overeind als de details onleesbaar zijn', async () => {
    const { kv, keys } = fakeKv();
    const store = createFailureStore(kv, '', () => 10);
    await store.record(failure());
    for (const k of [...keys.keys()]) {
      keys.set(k, '{"itemId":123}');
    }
    const lijst = await store.list();
    expect(lijst).toHaveLength(1);
    expect(lijst[0].variant).toBe('met');
  });

  /**
   * `JSON.parse` werpt bij kapotte tekst. Zonder afvangst per waarde viel de hele `list()` om,
   * werd het een algemene controlestoring, en verdween élke afzonderlijke melding van het bord.
   */
  it('laat één kapotte waarde de rest niet meeslepen', async () => {
    const { kv, keys } = fakeKv();
    const store = createFailureStore(kv, '', () => 10);
    await store.record(failure({ itemId: 'i1' }));
    await store.record(failure({ itemId: 'i2', atMs: 2 }));
    keys.set('evalmail:failed:i1:met', 'dit is geen json {');

    const lijst = await store.list();
    expect(lijst).toHaveLength(2);
    expect(lijst.map((f) => f.itemId)).toEqual(['i1', 'i2']);
    expect(lijst[1].klanttitel).toBe('Onderhandelen');
  });

  it('onthoudt de variant ook als alleen de index over is', async () => {
    const { kv, keys } = fakeKv();
    const store = createFailureStore(kv, '', () => 10);
    await store.record(failure({ variant: 'zonder' }));
    keys.clear();
    expect((await store.list())[0].variant).toBe('zonder');
  });

  /**
   * Zonder eigen ruimte zou een geslaagde herstelrun naar een testadres een échte openstaande
   * mislukking wegpoetsen, terwijl er naar de echte postbussen nog steeds niets is gegaan.
   */
  it('houdt een omgeleide test gescheiden van de echte meldingen', async () => {
    const { kv } = fakeKv();
    const productie = createFailureStore(kv, '', () => 10);
    const test = createFailureStore(kv, 'test-abc123:', () => 10);

    await productie.record(failure());
    await test.record(failure({ reden: 'testfout' }));

    expect(await productie.list()).toEqual([failure()]);
    expect((await test.list()).map((f) => f.reden)).toEqual(['testfout']);
  });

  it('laat een echte melding staan als de test hem opruimt', async () => {
    const { kv } = fakeKv();
    const productie = createFailureStore(kv, '', () => 10);
    const test = createFailureStore(kv, 'test-abc123:', () => 10);

    await productie.record(failure());
    await test.record(failure());
    await test.clear('i1', 'met');

    expect(await productie.list()).toHaveLength(1);
  });

  it('vraagt er nooit meer op dan de bovengrens', async () => {
    const { kv } = fakeKv();
    const store = createFailureStore(kv, '', () => 10_000);
    for (let i = 0; i < MAX_FAILURES + 20; i += 1) {
      await store.record(failure({ itemId: `i${i}`, atMs: i }));
    }
    expect((await store.list()).length).toBeLessThanOrEqual(MAX_FAILURES);
  });
});
