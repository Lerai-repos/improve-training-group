/**
 * De opslag van de bevestigde cycli: Upstash in productie, geheugen in tests.
 *
 * Apart van `cyclus-bevestiging.ts`, en dat is dragend: dat bestand komt via `cyclus.ts` en
 * `tab.ts` in de browserbundel terecht, en dit bestand gebruikt `node:crypto`. Stonden ze bij
 * elkaar, dan faalt `next build` op de tab-pagina — terwijl vitest, tsc en de dev-server er
 * niets van zeggen.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { CYCLUS_TTL_MS, cyclusStoreKey } from './cyclus-bevestiging';

import type { Redis } from '@upstash/redis';

import type { BevestigdeCycli, CyclusStore } from './cyclus-bevestiging';

const storeKey = cyclusStoreKey;

const verhuizingSchema = z.object({
  naar: z.string().min(1),
  bronnen: z.array(z.string().min(1)),
  gezaghebbend: z.string().min(1).optional(),
});

const groepSchema = z.object({
  leden: z.array(z.string().min(1)).min(2),
  anker: z.string().min(1),
});

const schema = z.object({
  v: z.literal(1),
  groepen: z.array(groepSchema),
  beslist: z.record(z.string(), z.array(z.string().min(1))),
  /** Ouder record: geen openstaande verhuizingen. */
  verhuizingen: z.array(verhuizingSchema).optional(),
  savedAt: z.string(),
});

function decode(raw: string | null): BevestigdeCycli | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  /**
   * Onleesbaar leest hier als "nog niet beantwoord", en dat mag: de tab stelt de vraag dan
   * opnieuw en elke sessie houdt tot die tijd haar eigen briefing. Er gaat dus nooit een
   * gebundeld document uit op grond van iets dat we niet konden lezen.
   */
  return result.success
    ? {
        groepen: result.data.groepen,
        beslist: result.data.beslist,
        verhuizingen: result.data.verhuizingen ?? [],
      }
    : null;
}

const encode = (value: BevestigdeCycli, nowIso: string): string =>
  JSON.stringify({
    v: 1,
    groepen: value.groepen.map((groep) => ({ leden: [...groep.leden], anker: groep.anker })),
    beslist: Object.fromEntries(Object.entries(value.beslist).map(([id, ids]) => [id, [...ids]])),
    verhuizingen: value.verhuizingen.map((v) => ({
      naar: v.naar,
      bronnen: [...v.bronnen],
      ...(v.gezaghebbend === undefined ? {} : { gezaghebbend: v.gezaghebbend }),
    })),
    savedAt: nowIso,
  });

/**
 * Schrijf alleen als er niets veranderd is sinds we lazen; anders opnieuw proberen.
 *
 * Hetzelfde patroon als de checklist-store, maar zonder token naar buiten: de aanroeper
 * beschrijft alleen de wijziging, en het verzoenen gebeurt hier. `''` staat voor afwezig, want
 * een Lua-tabel kapt af bij de eerste nil en wij schrijven nooit een lege string.
 */
const LUA_CAS = `
local current = redis.call('GET', KEYS[1])
local token = ARGV[3]
if current then
  token = redis.sha1hex(current)
end
if token ~= ARGV[1] then
  return {0, current or ''}
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[4]))
return {1, ARGV[2]}
`;

/** Het token voor een sleutel die er niet is. Geen hash, en het kan er niet mee botsen. */
const ABSENT_TOKEN = 'absent';

/** Genoeg om twee adviseurs die tegelijk bevestigen uit elkaar te trekken. */
const MAX_POGINGEN = 3;

const tokenOf = (raw: string | null): string =>
  raw === null ? ABSENT_TOKEN : createHash('sha1').update(raw).digest('hex');

export function createUpstashCyclusStore(
  redis: Redis,
  now: () => Date = () => new Date()
): CyclusStore {
  const lees = async (key: string): Promise<string | null> => {
    const raw = await redis.get<string | null>(key);
    return raw === undefined ? null : raw;
  };

  return {
    async read(opportunityItemId) {
      return decode(await lees(storeKey(opportunityItemId)));
    },

    async readMetFence(opportunityItemId) {
      const key = storeKey(opportunityItemId);
      const raw = await lees(key);
      return { stand: decode(raw), fence: { key, token: tokenOf(raw) } };
    },

    async update(opportunityItemId, maak) {
      const key = storeKey(opportunityItemId);
      for (let poging = 0; poging < MAX_POGINGEN; poging += 1) {
        const raw = await lees(key);
        const vorige = decode(raw);
        const volgende = maak(vorige);
        const res = await redis.eval(
          LUA_CAS,
          [key],
          [tokenOf(raw), encode(volgende, now().toISOString()), ABSENT_TOKEN, String(CYCLUS_TTL_MS)]
        );
        if (!Array.isArray(res) || res.length !== 2) {
          throw new Error('cyclus store: onverwacht antwoord van het script');
        }
        if (res[0] === 1) {
          return { vorige, volgende };
        }
      }
      throw new Error(
        `cyclus store: ${MAX_POGINGEN} keer op rij kwam er een andere wijziging tussen; ` +
          'probeer het opnieuw.'
      );
    },
  };
}

/**
 * Een store in het geheugen, voor tests en voor draaien zonder Redis.
 *
 * `hekToken` is wat een geheugen-checklist-store aan `createMemoryChecklistStore` geeft, zodat
 * de twee in een test hetzelfde hek delen als in Redis.
 */
export function createMemoryCyclusStore(
  now: () => Date = () => new Date()
): CyclusStore & { hekToken(key: string): Promise<string> } {
  const rows = new Map<string, string>();
  return {
    hekToken(key) {
      return Promise.resolve(tokenOf(rows.get(key) ?? null));
    },
    read(opportunityItemId) {
      return Promise.resolve(decode(rows.get(storeKey(opportunityItemId)) ?? null));
    },
    readMetFence(opportunityItemId) {
      const key = storeKey(opportunityItemId);
      const raw = rows.get(key) ?? null;
      return Promise.resolve({ stand: decode(raw), fence: { key, token: tokenOf(raw) } });
    },
    update(opportunityItemId, maak) {
      const key = storeKey(opportunityItemId);
      const vorige = decode(rows.get(key) ?? null);
      const volgende = maak(vorige);
      rows.set(key, encode(volgende, now().toISOString()));
      return Promise.resolve({ vorige, volgende });
    },
  };
}
