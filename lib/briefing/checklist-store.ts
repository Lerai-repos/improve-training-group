/**
 * De antwoorden van de adviseur, bewaard per training.
 *
 * Dit is de invoer van de briefing: de zes vinkjes, wie de acteur is, en de concept-inhoud
 * zoals de adviseur hem heeft achtergelaten. Besloten 19-Aug-2026 dat dit **in KV** leeft en
 * niet op een bord: het Briefings-bord registreert wat er geproduceerd is, de app bezit de
 * invoer. Zie het geheugen `itg-briefing-design-decisions`.
 *
 * ## Waarom hetzelfde compare-and-set als de WhatsApp-tekst
 *
 * `conceptInhoud` is een tekstvak waar iemand een half programma in typt. Twee tabbladen
 * open, of een verzoek dat opnieuw wordt geprobeerd nadat het antwoord wegviel, en zonder
 * teken van wie-wat-wanneer verdwijnt dat werk zonder spoor.
 *
 * De opzet is bewust een spiegel van `lib/recommend/whatsapp-store.ts`, tot en met het
 * Lua-script: één token dat de sha1 van de opgeslagen bytes is, een sentinel voor "er staat
 * niets", en een grafsteen bij het wissen zodat "weggegooid" niet als "nooit opgeslagen"
 * leest. Twee kopieën van twaalf regels Lua zijn goedkoper dan die twee stores door één
 * abstractie persen; komt er een derde, dan is het tijd om te extraheren.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Redis } from '@upstash/redis';

import { CONCEPT_MAX_LENGTH, type SavedChecklist } from './answers';

export { CONCEPT_MAX_LENGTH, EMPTY_SAVED, validateChecklist } from './answers';
export type { SavedChecklist } from './answers';

/** Zelfde bewaartermijn als de aanbevelingsrijen: de training zelf is het einde. */
export const CHECKLIST_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Het token voor een sleutel die er niet is. Geen hash, en het kan er niet mee botsen. */
const ABSENT_TOKEN = 'absent';

const storeKey = (mondayItemId: string): string => `briefing:checklist:${mondayItemId}`;

export interface ChecklistSnapshot {
  readonly saved: SavedChecklist | null;
  /** Ondoorzichtig token. Stuur het terug bij elke schrijfactie; interpreteer het nooit. */
  readonly token: string;
  /** Er stáát iets en het is niet te lezen — iets anders dan dat er niets staat. */
  readonly unreadable: boolean;
}

export type ChecklistWrite =
  | { readonly kind: 'ok'; readonly saved: SavedChecklist | null; readonly token: string }
  | {
      readonly kind: 'conflict';
      readonly saved: SavedChecklist | null;
      readonly token: string;
      readonly unreadable: boolean;
    };

/**
 * Een tweede sleutel die niet veranderd mag zijn, wil de schrijfactie doorgaan.
 *
 * Voor de trainingscyclus: onder welk item de antwoorden horen volgt uit het cyclusrecord, en dat
 * kan veranderen tussen het bepalen en het schrijven. Elke schrijfactie die daarvan afhangt
 * draagt daarom het token van dat record mee, en het script controleert beide in één adem. Een
 * controle ná het schrijven is te laat: dan staat het er al.
 */
export interface Fence {
  readonly key: string;
  /** De sha1 van de bytes van die sleutel, of `absent`. */
  readonly token: string;
}

export interface ChecklistStore {
  read(mondayItemId: string): Promise<ChecklistSnapshot>;
  save(
    mondayItemId: string,
    input: SavedChecklist & { token: string },
    fence?: Fence
  ): Promise<ChecklistWrite>;
  /**
   * Het record vervangen door een grafsteen, met dezelfde tokencontrole als `save`.
   *
   * Voor de trainingscyclus: de antwoorden leven op precies één plek, het anker. Een sessie die
   * bij een cyclus komt of waarvan het anker verschuift houdt anders een oud record dat later
   * weer voor "de antwoorden" kan doorgaan. Een grafsteen en geen `DEL`, zodat "weggehaald" niet
   * hetzelfde leest als "nooit opgeslagen".
   */
  clear(mondayItemId: string, token: string, fence?: Fence): Promise<'ok' | 'conflict'>;
}

/**
 * Cyclus, huiswerk en voorbereidende opdracht stonden hier tot 17-Sep-2026; ze komen nu van
 * het agendabord. Oudere records dragen ze nog, en Zod laat onbekende sleutels vallen, dus die
 * blijven leesbaar zonder dat een oud vinkje het bord overstemt.
 */
const checklistSchema = z.object({
  ownGroup: z.boolean(),
  sameGroup: z.boolean(),
  trainingActor: z.boolean(),
  conceptInhoud: z.string().max(CONCEPT_MAX_LENGTH).optional(),
  achtergrondInhoud: z.string().max(CONCEPT_MAX_LENGTH).optional(),
});

const recordSchema = z.object({
  v: z.literal(1),
  checklist: checklistSchema,
  actorItemIds: z.array(z.string()),
  /**
   * Toegevoegd ná de eerste versie: oudere records missen dit veld, en dat leest als "nee".
   *
   * `mondayChallenge` stond hier ook. Dat veld is vervallen toen de harde regel onder de
   * achtergrondinformatie uit het sjabloon ging: de aansporing staat nu onvoorwaardelijk
   * bovenaan, uit ITG's eigen brondocument, dus er valt niets meer aan te zetten. Zod laat
   * onbekende sleutels vallen, dus records die het veld nog dragen blijven gewoon leesbaar.
   */
  actorAnswered: z.boolean().optional(),
  savedAt: z.string(),
});

const tombstoneSchema = z.object({ v: z.literal(1), deleted: z.literal(true), at: z.string() });

const storedSchema = z.union([recordSchema, tombstoneSchema]);

type Stored =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'tombstone' }
  | { kind: 'record'; saved: SavedChecklist };

/**
 * Het token, berekend over precies de bytes die Redis vasthoudt.
 *
 * Dat dit overeenkomt met `redis.sha1hex` in het script hangt ervan af dat de client de
 * waarde onbewerkt teruggeeft — wat hij doet, omdat `createRedisClient`
 * `automaticDeserialization: false` zet. Zou dat veranderen, dan krijgt de client een
 * ontleed object terug, kan het opnieuw coderen een byte schelen, en botst élke schrijfactie.
 */
export function tokenOf(raw: string | null): string {
  return raw === null ? ABSENT_TOKEN : createHash('sha1').update(raw).digest('hex');
}

function decode(raw: string | null): Stored {
  if (raw === null) {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  const result = storedSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'unreadable' };
  }
  if ('deleted' in result.data) {
    return { kind: 'tombstone' };
  }
  return {
    kind: 'record',
    saved: {
      checklist: result.data.checklist,
      actorItemIds: result.data.actorItemIds,
      /**
       * Ontbreekt dit veld, dan is de vraag **niet** beantwoord.
       *
       * `true` teruggeven zou precies de fout bewaren waarvoor dit veld bestaat: zo'n record
       * kan er ook staan omdat iemand *huiswerk* aanvinkte of de concept-inhoud aanpaste, en
       * dan is het acteurvoorstel nooit bevestigd. Dat kost hoogstens één klik op een training
       * die al eens is aangeraakt; het alternatief is een ontbrekend acteurblok dat niemand
       * opmerkt.
       */
      actorAnswered: result.data.actorAnswered ?? false,
    },
  };
}

const snapshotOf = (raw: string | null): ChecklistSnapshot => {
  const stored = decode(raw);
  return {
    saved: stored.kind === 'record' ? stored.saved : null,
    token: tokenOf(raw),
    unreadable: stored.kind === 'unreadable',
  };
};

const encodeTombstone = (nowIso: string): string =>
  JSON.stringify({ v: 1, deleted: true, at: nowIso });

function encodeRecord(input: SavedChecklist, nowIso: string): string {
  return JSON.stringify({
    v: 1,
    checklist: input.checklist,
    actorItemIds: [...input.actorItemIds],
    actorAnswered: input.actorAnswered,
    savedAt: nowIso,
  });
}

/**
 * Een botsing die in werkelijkheid dezelfde schrijfactie twee keer is.
 *
 * Redis legt vast, het antwoord valt weg, de client probeert opnieuw met het token dat hij
 * nog heeft — en een naïeve CAS meldt "een collega heeft dit gewijzigd" over het eigen werk
 * van de adviseur. Een mismatch waarvan de inhoud gelijk is aan wat we wilden schrijven geldt
 * daarom als geslaagd. `savedAt` verschilt altijd, dus dit vergelijkt betekenis en niet bytes.
 */
function reconcile(current: string | null, input: SavedChecklist): ChecklistWrite {
  const snapshot = snapshotOf(current);
  const zelfde =
    snapshot.saved !== null &&
    JSON.stringify(snapshot.saved.checklist) === JSON.stringify(input.checklist) &&
    JSON.stringify([...snapshot.saved.actorItemIds].sort()) ===
      JSON.stringify([...input.actorItemIds].sort()) &&
    snapshot.saved.actorAnswered === input.actorAnswered;

  return zelfde
    ? { kind: 'ok', saved: snapshot.saved, token: snapshot.token }
    : { kind: 'conflict', ...snapshot };
}

/**
 * Vergelijk het token — en het hek, als dat er is — en schrijf dan. Eén script, dus er komt
 * niets tussen.
 *
 * Geeft `{ 0, current }` bij een mismatch, zodat de aanroeper kan verzoenen zonder tweede
 * ronde — en `''` voor afwezig, want een Lua-tabel kapt af bij de eerste nil. We schrijven
 * nooit een lege string, dus die twee zijn niet te verwarren. `{ 2, current }` betekent dat het
 * hek het tegenhield: de cyclus is intussen veranderd.
 *
 * KEYS[2] is de heksleutel, of dezelfde sleutel als er geen hek is; ARGV[5] is dan `''`.
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
if ARGV[5] ~= '' then
  local hek = redis.call('GET', KEYS[2])
  local hektoken = ARGV[3]
  if hek then
    hektoken = redis.sha1hex(hek)
  end
  if hektoken ~= ARGV[5] then
    return {2, current or ''}
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[4]))
return {1, ARGV[2]}
`;

/** De sleutels en het hek-argument voor het script. */
const metHek = (key: string, fence: Fence | undefined): { keys: string[]; hek: string } => ({
  keys: [key, fence?.key ?? key],
  hek: fence?.token ?? '',
});

export function createUpstashChecklistStore(
  redis: Redis,
  now: () => Date = () => new Date()
): ChecklistStore {
  return {
    async read(mondayItemId) {
      const raw = await redis.get<string | null>(storeKey(mondayItemId));
      return snapshotOf(raw === undefined ? null : raw);
    },

    async save(mondayItemId, input, fence) {
      const next = encodeRecord(input, now().toISOString());
      const { keys, hek } = metHek(storeKey(mondayItemId), fence);
      const res = await redis.eval(LUA_CAS, keys, [
        input.token,
        next,
        ABSENT_TOKEN,
        String(CHECKLIST_TTL_MS),
        hek,
      ]);
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error('checklist store: onverwacht antwoord van het script');
      }
      const [won, value] = res;
      const current = value === '' ? null : String(value);
      if (won === 1) {
        return { kind: 'ok', saved: { ...input }, token: tokenOf(current) };
      }
      /**
       * Hield het hek het tegen, dan is dit géén dubbele schrijfactie van onszelf maar een
       * verschoven cyclus: de aanroeper moet opnieuw laden, ook al zou de inhoud toevallig
       * gelijk zijn.
       */
      return won === 2 ? { kind: 'conflict', ...snapshotOf(current) } : reconcile(current, input);
    },

    async clear(mondayItemId, token, fence) {
      const { keys, hek } = metHek(storeKey(mondayItemId), fence);
      const res = await redis.eval(LUA_CAS, keys, [
        token,
        encodeTombstone(now().toISOString()),
        ABSENT_TOKEN,
        String(CHECKLIST_TTL_MS),
        hek,
      ]);
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error('checklist store: onverwacht antwoord van het script');
      }
      return res[0] === 1 ? 'ok' : 'conflict';
    },
  };
}

/**
 * Een store in het geheugen, voor tests en voor draaien zonder Redis.
 *
 * `hekToken` beantwoordt wat het script in Redis zelf zou lezen: de sha1 van de heksleutel. In
 * een test is dat de geheugenversie van de cyclusstore; zonder hek wordt hij nooit gevraagd.
 */
export function createMemoryChecklistStore(
  now: () => Date = () => new Date(),
  hekToken: (key: string) => Promise<string> = () => Promise.resolve(ABSENT_TOKEN)
): ChecklistStore {
  const rows = new Map<string, string>();
  const hekHoudt = async (fence: Fence | undefined): Promise<boolean> =>
    fence === undefined || (await hekToken(fence.key)) === fence.token;
  return {
    read(mondayItemId) {
      return Promise.resolve(snapshotOf(rows.get(storeKey(mondayItemId)) ?? null));
    },
    async save(mondayItemId, input, fence) {
      const key = storeKey(mondayItemId);
      const current = rows.get(key) ?? null;
      if (tokenOf(current) !== input.token) {
        return reconcile(current, input);
      }
      if (!(await hekHoudt(fence))) {
        return { kind: 'conflict', ...snapshotOf(current) };
      }
      const next = encodeRecord(input, now().toISOString());
      rows.set(key, next);
      return { kind: 'ok', saved: { ...input }, token: tokenOf(next) };
    },
    async clear(mondayItemId, token, fence) {
      const key = storeKey(mondayItemId);
      if (tokenOf(rows.get(key) ?? null) !== token || !(await hekHoudt(fence))) {
        return 'conflict';
      }
      rows.set(key, encodeTombstone(now().toISOString()));
      return 'ok';
    },
  };
}
