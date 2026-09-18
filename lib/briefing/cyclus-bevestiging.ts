/**
 * Wat de adviseur bevestigd heeft over de trainingscycli van één opdracht.
 *
 * Tim, 18-Sep-2026: de regel stelt sessies voor, een mens vinkt aan welke samen één briefing
 * krijgen. Dat antwoord hoort **bij de Opportunity** en niet bij één sessie: onder één opdracht
 * kunnen meerdere cycli staan (Reinaerde heeft er twee), en het antwoord moet blijven staan als
 * de regel later iets anders zou vinden — bijvoorbeeld omdat iemand een trainer wisselt.
 *
 * In KV en niet op een bord, om dezelfde reden als de checklist: dit is invoer van de app, geen
 * administratie van ITG. Zie `itg-briefing-design-decisions`.
 *
 * `beslist` is de reden dat de vraag niet elke keer terugkomt: per sessie staat erin tegen welke
 * andere sessies haar indeling beslist is. Komt er later een sessie bij onder dezelfde opdracht,
 * dan staat die er niet in en stelt de tab de vraag opnieuw — mét die nieuwe sessie erbij.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Redis } from '@upstash/redis';

import type { Fence } from './checklist-store';

/** Twee jaar: een cyclus kan over de jaarwisseling lopen en blijft daarna leesbaar. */
export const CYCLUS_TTL_MS = 730 * 24 * 60 * 60 * 1000;

/** Geëxporteerd omdat de checklist-store deze sleutel als hek gebruikt. */
export const cyclusStoreKey = (opportunityItemId: string): string =>
  `briefing:cyclus:${opportunityItemId}`;
const storeKey = cyclusStoreKey;

/**
 * Eén bevestigde cyclus.
 *
 * `anker` is waar de antwoorden STAAN — vastgelegd, niet afgeleid. Afleiden ("de eerste sessie
 * die te schrijven is") ging mis zodra dat verschoof: na een jaarwisseling stonden de antwoorden
 * nog onder de gearchiveerde eerste sessie, terwijl de afleiding een sessie aanwees die hooguit
 * een restant van vóór de cyclus droeg. Nu wijst het record het aan, en verhuist het anker alleen
 * door een vastgelegde verhuizing.
 */
export interface Groep {
  readonly leden: readonly string[];
  readonly anker: string;
}

export interface BevestigdeCycli {
  /** Elke groep is één briefing. Een sessie die in geen groep staat, krijgt haar eigen briefing. */
  readonly groepen: readonly Groep[];
  /**
   * Per sessie: tegen wélke andere sessies haar indeling beslist is.
   *
   * **Per sessie en niet één lijst voor de hele opdracht.** Onder één Opportunity kunnen twee
   * cycli staan; met één gedeelde lijst maakte het bevestigen van cyclus A de sessies van
   * cyclus B "beslist", waarna B zonder vraag als "geen cyclus" op het scherm kwam — een
   * antwoord dat niemand had gegeven.
   */
  readonly beslist: Readonly<Record<string, readonly string[]>>;
  /**
   * Verhuizingen die nog moeten gebeuren: antwoorden die naar een ander item moeten.
   *
   * **Ze staan hier en niet alleen in het geheugen van de aanroeper**, want een indeling
   * wijzigen en de antwoorden meeverhuizen zijn samen één handeling die niet half af mag
   * blijven. Ze worden in dezelfde schrijfactie vastgelegd als de nieuwe indeling; daarna voert
   * wie dan ook ze uit en haalt ze weg. Mislukt dat, dan staat het er de volgende keer nog, en
   * maakt de eerstvolgende lezing van de tab het alsnog af.
   */
  readonly verhuizingen: readonly Verhuizing[];
}

/**
 * Eén verhuizing: kopieer de antwoorden van de eerste bron die ze heeft naar `naar`.
 *
 * `gezaghebbend` is de bron die het wint van wat er al onder `naar` staat: het anker van de groep
 * zoals die wás. Een sessie die lid was van die groep kan een eigen, ouder record dragen van vóór
 * ze meedeed; dat is geen invoer meer maar een restant, en het mag de gedeelde antwoorden niet
 * verdringen zodra die sessie het nieuwe anker wordt.
 */
export interface Verhuizing {
  readonly naar: string;
  readonly bronnen: readonly string[];
  readonly gezaghebbend?: string;
}

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

/** Het record van een opdracht mét de versie waar een schrijfactie op de checklist op kan hekken. */
export interface CyclusStand {
  readonly stand: BevestigdeCycli | null;
  readonly fence: Fence;
}

export interface CyclusStore {
  read(opportunityItemId: string): Promise<BevestigdeCycli | null>;
  /**
   * Hetzelfde, mét het hek: de sha1 van precies de bytes die gelezen zijn. Wie hieruit afleidt
   * waar antwoorden horen te staan, geeft dat hek mee aan de checklist-store, zodat die
   * schrijfactie niet doorgaat als het record intussen is veranderd.
   */
  readMetFence(opportunityItemId: string): Promise<CyclusStand>;
  /**
   * Lezen, aanpassen en wegschrijven als één geheel.
   *
   * Twee adviseurs die tegelijk elk een eigen cyclus onder dezelfde opdracht bevestigen lezen
   * anders dezelfde stand, en dan wist de laatste schrijfactie de groep van de eerste zonder
   * dat iemand iets merkt.
   *
   * `maak` is **puur**: hij rekent alleen de nieuwe stand uit en schrijft zelf niets weg. Werk
   * met gevolgen buiten dit record — de antwoorden verhuizen — hoort in `verhuizingen`, zodat
   * het bij de stand hoort die de schrijfactie wint en niet bij een poging die verloor.
   */
  update(
    opportunityItemId: string,
    maak: (huidig: BevestigdeCycli | null) => BevestigdeCycli
  ): Promise<{ vorige: BevestigdeCycli | null; volgende: BevestigdeCycli }>;
}

/**
 * De nieuwe stand na een bevestiging vanaf `itemId`.
 *
 * `gekozen` zijn de aangevinkte sessies inclusief de training zelf; `getoond` is alles wat er op
 * het scherm stond, zodat de vraag daarna niet terugkomt.
 *
 * Twee dingen gebeuren er, en het verschil doet ertoe: de groep waar deze training in zat wordt
 * vervangen — ook een sessie die eruit gevinkt is, staat er daarna niet meer in — en een
 * aangevinkte sessie wordt uit een ándere groep gehaald, want ze kan maar in één briefing zitten.
 * Een groep waar niets van dit alles mee gebeurt blijft staan: onder één opdracht kunnen twee
 * cycli leven (Reinaerde), en bevestigen vanaf de ene mag de andere niet slopen.
 */
export function metBevestiging(
  huidig: BevestigdeCycli | null,
  itemId: string,
  gekozen: readonly string[],
  getoond: readonly string[],
  /** Waar de antwoorden van een groep komen te staan: de eerste sessie die te schrijven is. */
  ankerVoor: (leden: readonly string[]) => string
): BevestigdeCycli {
  const gekozenSet = new Set([...gekozen, itemId]);
  const overig: Groep[] = (huidig?.groepen ?? [])
    .filter((groep) => !groep.leden.includes(itemId))
    .map((groep) => {
      const leden = groep.leden.filter((id) => !gekozenSet.has(id));
      /**
       * Verliest een groep haar anker aan deze keuze, dan krijgt de rest een nieuw anker en
       * volgt een verhuizing daarheen (`andereCycli`). Blijft het anker, dan verandert er niets.
       */
      return { leden, anker: leden.includes(groep.anker) ? groep.anker : ankerVoor(leden) };
    })
    .filter((groep) => groep.leden.length > 1);
  const nieuw = [...gekozenSet].sort();
  const groepen: Groep[] =
    nieuw.length > 1 ? [...overig, { leden: nieuw, anker: ankerVoor(nieuw) }] : overig;

  /**
   * Beslist is alleen wie er in deze groep zit. Bevestigen geldt voor de hele groep — wie
   * sessie 2 aanvinkt beantwoordt de vraag ook voor sessie 2 — maar zegt niets over een sessie
   * die de adviseur juist uit liet staan: die kan zelf nog bij een andere cyclus horen.
   */
  const beslist: Record<string, readonly string[]> = { ...(huidig?.beslist ?? {}) };
  /**
   * Wie door deze wijziging zonder groep achterblijft, moet opnieuw gevraagd worden.
   *
   * Voorbeeld: `[c, d]` was bevestigd en nu wordt `c` bij een andere cyclus gevinkt. Dan valt
   * `d` uit zijn groep, maar zijn oude antwoord staat er nog — en dan meldt de tab op `d`
   * doodleuk "geen cyclus", terwijl niemand dat over `d` heeft gezegd. Zijn beslissing vervalt
   * dus met zijn groep.
   */
  const houdtGroep = new Set(groepen.flatMap((groep) => groep.leden));
  const uitElkaar = (huidig?.groepen ?? [])
    .filter(
      (groep) => groep.leden.includes(itemId) || groep.leden.some((id) => gekozenSet.has(id))
    )
    .flatMap((groep) => groep.leden);
  for (const id of uitElkaar) {
    if (!houdtGroep.has(id)) {
      delete beslist[id];
    }
  }

  for (const id of gekozenSet) {
    beslist[id] = [...new Set(getoond)].sort();
  }
  return { groepen, beslist, verhuizingen: huidig?.verhuizingen ?? [] };
}

/** De groep waar een sessie in zit, of `null`. */
export function groepVan(stand: BevestigdeCycli | null, itemId: string): Groep | null {
  return stand?.groepen.find((groep) => groep.leden.includes(itemId)) ?? null;
}

/**
 * Dezelfde stand, met het anker van één groep verplaatst.
 *
 * Voor de jaarwisseling: het anker staat op een bord dat gearchiveerd is en is daar niet meer te
 * beschrijven. De verhuizing die erbij hoort legt de aanroeper vast met `metVerhuizingen`.
 */
export function metAnker(stand: BevestigdeCycli, leden: readonly string[], anker: string): BevestigdeCycli {
  const sleutel = [...leden].sort().join(',');
  return {
    ...stand,
    groepen: stand.groepen.map((groep) =>
      [...groep.leden].sort().join(',') === sleutel ? { ...groep, anker } : groep
    ),
  };
}

/** Dezelfde stand, met de verhuizingen die bij deze wijziging horen erbij. */
export function metVerhuizingen(
  stand: BevestigdeCycli,
  verhuizingen: readonly Verhuizing[]
): BevestigdeCycli {
  const nieuw = verhuizingen.filter((v) => v.bronnen.some((bron) => bron !== v.naar));
  return { ...stand, verhuizingen: [...stand.verhuizingen, ...nieuw] };
}

/** Dezelfde stand, zonder de verhuizingen die gedaan zijn. */
export function zonderVerhuizingen(
  stand: BevestigdeCycli,
  gedaan: readonly Verhuizing[]
): BevestigdeCycli {
  const sleutels = new Set(gedaan.map(sleutelVan));
  return { ...stand, verhuizingen: stand.verhuizingen.filter((v) => !sleutels.has(sleutelVan(v))) };
}

const sleutelVan = (v: Verhuizing): string =>
  `${v.naar}<${[...v.bronnen].sort().join(',')}<${v.gezaghebbend ?? ''}`;

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
          [
            tokenOf(raw),
            encode(volgende, now().toISOString()),
            ABSENT_TOKEN,
            String(CYCLUS_TTL_MS),
          ]
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
