import { describe, expect, it } from 'vitest';

import {
  CLAIM_TTL_MS,
  createSentGuard,
  deliveryNamespace,
  LUA_OWNED_WRITE,
  SENT_TTL_MS,
} from '../sent-store';

import type { ClaimToken, SentStoreRedis } from '../sent-store';

/**
 * Een Redis die de twee bewerkingen echt uitvoert, inclusief het eigenaarschap.
 *
 * Het Lua-script wordt hier naar zijn contract nagespeeld en niet uitgevoerd; wat deze tests
 * bewaken is de bedrading eromheen — dat het token meegaat, dat een vreemde claim met rust
 * blijft, en dat kort een lange TTL wordt zodra de verzending gelukt is. Het script zelf is
 * acht regels en spiegelt `lib/briefing/checklist-store.ts`, dat al in productie draait.
 */
function fakeRedis(): {
  redis: SentStoreRedis;
  keys: Map<string, { value: string; ttlMs: number }>;
  evals: Array<{ keys: string[]; args: string[] }>;
} {
  const keys = new Map<string, { value: string; ttlMs: number }>();
  const evals: Array<{ keys: string[]; args: string[] }> = [];

  const redis: SentStoreRedis = {
    async set(key, value, opts) {
      if (opts.nx && keys.has(key)) {
        return null;
      }
      keys.set(key, { value, ttlMs: opts.px });
      return 'OK';
    },
    async get(key) {
      return keys.get(key)?.value ?? null;
    },
    async eval(_script, evalKeys, args) {
      evals.push({ keys: evalKeys, args });
      const [key] = evalKeys;
      const [token, waarde, ttl] = args;
      if (keys.get(key)?.value !== token) {
        return 0;
      }
      if (waarde === '') {
        keys.delete(key);
      } else {
        keys.set(key, { value: waarde, ttlMs: Number(ttl) });
      }
      return 1;
    },
  };
  return { redis, keys, evals };
}

/** Claimen en het token eruit halen; een test die hier struikelt is zelf fout. */
async function claimOf(
  guard: ReturnType<typeof createSentGuard>,
  itemId: string,
  variant: 'met' | 'zonder',
  nowMs = 1
): Promise<ClaimToken> {
  const result = await guard.claim(itemId, variant, nowMs);
  if (result.kind !== 'claimed') {
    throw new Error('verwachtte een geslaagde claim');
  }
  return result.token;
}

describe('createSentGuard', () => {
  it('laat de eerste door en de tweede niet', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    expect((await guard.claim('i1', 'met', 1)).kind).toBe('claimed');
    expect((await guard.claim('i1', 'met', 2)).kind).toBe('bezet');
  });

  it('blokkeert de andere variant NIET', async () => {
    // Komen de reacties alsnog binnen, dan verandert de uitkomst van zonder naar met en
    // hoort die tweede mail er alsnog uit te gaan, met het rapport erbij.
    const guard = createSentGuard(fakeRedis().redis);
    expect((await guard.claim('i1', 'zonder', 1)).kind).toBe('claimed');
    expect((await guard.claim('i1', 'met', 2)).kind).toBe('claimed');
  });

  it('houdt trainingen uit elkaar', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    expect((await guard.claim('i1', 'met', 1)).kind).toBe('claimed');
    expect((await guard.claim('i2', 'met', 1)).kind).toBe('claimed');
  });

  it('laat een herstelrun toe nadat de claim is teruggegeven', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    const token = await claimOf(guard, 'i1', 'met');
    expect(await guard.release('i1', 'met', token)).toBe('ok');
    expect((await guard.claim('i1', 'met', 2)).kind).toBe('claimed');
  });
});

/**
 * De twee fasen. Een claim die meteen 180 dagen geldt maakt van elke afbreking tussen
 * claimen en versturen — Vercel dat afkapt, een deploy er middendoor — een mail die een half
 * jaar als verstuurd geldt zonder ooit verstuurd te zijn. Die storing geeft geen foutmelding;
 * er komt gewoon niets.
 */
describe('claim en confirm zijn twee verschillende dingen', () => {
  it('houdt een lopende verzending maar kort vast', async () => {
    const { redis, keys } = fakeRedis();
    await createSentGuard(redis).claim('i1', 'met', 1);
    expect([...keys.values()].map((v) => v.ttlMs)).toEqual([CLAIM_TTL_MS]);
    // Ruim boven de looptijd van de route, ver onder een half jaar.
    expect(CLAIM_TTL_MS).toBeLessThan(SENT_TTL_MS);
  });

  it('maakt er pas na een geslaagde verzending een duurzame markering van', async () => {
    const { redis, keys } = fakeRedis();
    const guard = createSentGuard(redis);
    const token = await claimOf(guard, 'i1', 'met');
    expect(await guard.confirm('i1', 'met', token, 2)).toBe('ok');

    expect([...keys.values()]).toEqual([{ value: 'verstuurd:2', ttlMs: SENT_TTL_MS }]);
    expect((await guard.claim('i1', 'met', 3)).kind).toBe('bezet');
  });

  /**
   * Het verschil tussen "een andere run is bezig" en "hij is aantoonbaar verstuurd" is wat de
   * dagjob gebruikt om een blijven-hangen-melding op te ruimen. Zonder dat onderscheid ruimt
   * hij op terwijl een ander nog aan het versturen is, of nooit.
   */
  it('zegt "bezig" zolang de verzending nog loopt', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    await claimOf(guard, 'i1', 'met');
    expect(await guard.claim('i1', 'met', 2)).toEqual({ kind: 'bezet', reden: 'bezig' });
  });

  it('zegt "verstuurd" zodra de verzending bevestigd is', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    const token = await claimOf(guard, 'i1', 'met');
    await guard.confirm('i1', 'met', token, 2);
    expect(await guard.claim('i1', 'met', 3)).toEqual({ kind: 'bezet', reden: 'verstuurd' });
  });

  it('zet er geen tweede sleutel naast', async () => {
    const { redis, keys } = fakeRedis();
    const guard = createSentGuard(redis);
    const token = await claimOf(guard, 'i1', 'met');
    await guard.confirm('i1', 'met', token, 2);
    expect(keys.size).toBe(1);
  });
});

/**
 * Het eigenaarschap. De korte claim kán verlopen terwijl de verzending nog loopt — het
 * handmatige script geeft zijn Graph-aanroepen geen looptijdgrens mee, dus een hangende
 * upload kan er langer over doen dan een kwartier. Dan is de sleutel inmiddels van een andere
 * run, en die mag niet overschreven of weggegooid worden.
 */
describe('een claim die inmiddels van een ander is', () => {
  const verlopenEnOvergenomen = async () => {
    const { redis, keys } = fakeRedis();
    const guard = createSentGuard(redis);
    const oud = await claimOf(guard, 'i1', 'met', 1);
    // De TTL loopt af en een tweede run pakt hem op.
    keys.delete('evalmail:v1:i1:met');
    const nieuw = await claimOf(guard, 'i1', 'met', 2);
    return { guard, keys, oud, nieuw };
  };

  it('wordt niet overschreven door de trage eerste run', async () => {
    const { guard, keys, oud, nieuw } = await verlopenEnOvergenomen();
    expect(await guard.confirm('i1', 'met', oud, 3)).toBe('verloren');
    expect(keys.get('evalmail:v1:i1:met')?.value).toBe(nieuw);
  });

  it('wordt niet weggegooid door de trage eerste run', async () => {
    const { guard, keys, oud } = await verlopenEnOvergenomen();
    expect(await guard.release('i1', 'met', oud)).toBe('verloren');
    expect(keys.has('evalmail:v1:i1:met')).toBe(true);
  });

  it('mag de tweede run wél afronden', async () => {
    const { guard, keys, nieuw } = await verlopenEnOvergenomen();
    expect(await guard.confirm('i1', 'met', nieuw, 4)).toBe('ok');
    expect(keys.get('evalmail:v1:i1:met')?.value).toBe('verstuurd:4');
  });

  it('stuurt het token altijd als eerste argument mee', async () => {
    const { redis, evals } = fakeRedis();
    const guard = createSentGuard(redis);
    const token = await claimOf(guard, 'i1', 'met');
    await guard.confirm('i1', 'met', token, 2);
    expect(evals[0].keys).toEqual(['evalmail:v1:i1:met']);
    expect(evals[0].args[0]).toBe(token);
  });

  it('geeft elke claim een eigen token', async () => {
    const guard = createSentGuard(fakeRedis().redis);
    const a = await claimOf(guard, 'i1', 'met', 1);
    const b = await claimOf(guard, 'i2', 'met', 1);
    expect(a).not.toBe(b);
  });
});

/**
 * Wat deze drie WÉL en NIET aantonen.
 *
 * De testdubbel hierboven speelt het script na naar zijn contract; hij voert geen Lua uit.
 * Wordt de vergelijking uit het script gesloopt, dan merken die tests dat dus niet — gemeten,
 * niet aangenomen. Deze drie kijken daarom naar de scripttekst zelf, zodat het weghalen van de
 * grendel in elk geval een rode test oplevert in plaats van stilte.
 *
 * Ze bewijzen NIET dat Redis het script goed uitvoert. Dat blijkt pas uit de eerste echte
 * verzending; het script is acht regels en spiegelt `lib/briefing/checklist-store.ts`, dat al
 * in productie draait.
 */
describe('het Lua-script zelf', () => {
  it('vergelijkt de opgeslagen waarde met het meegegeven token', () => {
    expect(LUA_OWNED_WRITE).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
  });

  it('stopt met 0 zodra dat niet klopt, vóór elke schrijfactie', () => {
    const guard = LUA_OWNED_WRITE.indexOf('~= ARGV[1]');
    const bail = LUA_OWNED_WRITE.indexOf('return 0');
    const write = LUA_OWNED_WRITE.indexOf("redis.call('SET'");
    const del = LUA_OWNED_WRITE.indexOf("redis.call('DEL'");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(bail).toBeGreaterThan(guard);
    expect(write).toBeGreaterThan(bail);
    expect(del).toBeGreaterThan(bail);
  });

  it('behandelt een lege waarde als verwijderen', () => {
    expect(LUA_OWNED_WRITE).toContain("ARGV[2] == ''");
  });
});

describe('deliveryNamespace', () => {
  const echt = { klant: 'aanvragen@itg.nl', trainer: 'backoffice@itg.nl' };

  it('laat productiesleutels met rust', () => {
    expect(deliveryNamespace({ ...echt, redirected: false })).toBe('');
  });

  /**
   * Zonder dit blokkeert één geslaagde testverzending naar je eigen adres de échte levering
   * aan aanvragen@ en backoffice@ voor 180 dagen — precies het eerste wat iemand doet.
   */
  it('zet een omgeleide test in zijn eigen ruimte', async () => {
    const test = { klant: 'tim@lerai.nl', trainer: 'tim@lerai.nl', redirected: true };
    const ruimte = deliveryNamespace(test);
    expect(ruimte).not.toBe('');

    const { redis } = fakeRedis();
    expect((await createSentGuard(redis, ruimte).claim('i1', 'met', 1)).kind).toBe('claimed');
    // De echte verzending is daarna nog gewoon toegestaan.
    expect((await createSentGuard(redis).claim('i1', 'met', 2)).kind).toBe('claimed');
  });

  it('geeft twee verschillende bestemmingen twee verschillende ruimtes', () => {
    const a = deliveryNamespace({ klant: 'a@x.nl', trainer: 'b@x.nl', redirected: true });
    const b = deliveryNamespace({ klant: 'b@x.nl', trainer: 'a@x.nl', redirected: true });
    expect(a).not.toBe(b);
  });
});
