import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { createKnopProbleemStore } from '../knop-store';

const probleem = (itemId: string, atMs = 1) => ({
  itemId,
  klanttitel: 'RSV Breda',
  datum: '2026-09-17',
  reden: 'IE-code 260814 staat ook op een andere training',
  atMs,
});

describe('createKnopProbleemStore', () => {
  it('bewaart een probleem tot het is opgelost', async () => {
    const store = createKnopProbleemStore(createMemoryKvStore());
    await store.record(probleem('i1'));
    expect(await store.list()).toEqual([probleem('i1')]);
  });

  /** Eén melding per training: de laatste knopdruk zegt wat er nu mis is. */
  it('overschrijft een eerder probleem van dezelfde training', async () => {
    const store = createKnopProbleemStore(createMemoryKvStore());
    await store.record(probleem('i1', 1));
    await store.record({ ...probleem('i1', 2), reden: 'iets anders' });
    expect(await store.list()).toEqual([{ ...probleem('i1', 2), reden: 'iets anders' }]);
  });

  it('haalt het weg zodra de knop wél lukt', async () => {
    const store = createKnopProbleemStore(createMemoryKvStore());
    await store.record(probleem('i1'));
    await store.record(probleem('i2'));
    await store.clear('i1');
    expect((await store.list()).map((p) => p.itemId)).toEqual(['i2']);
  });

  it('opruimen van iets wat er niet is, is geen fout', async () => {
    const store = createKnopProbleemStore(createMemoryKvStore());
    await expect(store.clear('i9')).resolves.toBeUndefined();
  });

  /**
   * Verdwijnen zou de dagelijkse controle laten denken dat het opgelost is. Dus afgeslankt
   * melden in plaats van weglaten — dezelfde keuze als bij de mislukte mails.
   */
  it('meldt een onleesbaar probleem afgeslankt in plaats van het te laten verdwijnen', async () => {
    const kv = createMemoryKvStore();
    const store = createKnopProbleemStore(kv);
    await store.record(probleem('i1'));
    await kv.set('evalknop:open:i1', '{kapot');
    expect(await store.list()).toEqual([
      expect.objectContaining({ itemId: 'i1', klanttitel: '(details niet meer beschikbaar)' }),
    ]);
  });
});
