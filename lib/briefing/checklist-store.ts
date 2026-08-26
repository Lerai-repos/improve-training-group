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

export interface ChecklistStore {
  read(mondayItemId: string): Promise<ChecklistSnapshot>;
  save(mondayItemId: string, input: SavedChecklist & { token: string }): Promise<ChecklistWrite>;
}

const checklistSchema = z.object({
  ownGroup: z.boolean(),
  sameGroup: z.boolean(),
  trainingCycle: z.boolean(),
  homework: z.boolean(),
  preparatoryAssignment: z.boolean(),
  trainingActor: z.boolean(),
  conceptInhoud: z.string().max(CONCEPT_MAX_LENGTH).optional(),
});

const recordSchema = z.object({
  v: z.literal(1),
  checklist: checklistSchema,
  actorItemIds: z.array(z.string()),
  // Toegevoegd ná de eerste versie: oudere records missen deze twee, en die lezen als "nee".
  mondayChallenge: z.boolean().optional(),
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
      mondayChallenge: result.data.mondayChallenge ?? false,
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

function encodeRecord(input: SavedChecklist, nowIso: string): string {
  return JSON.stringify({
    v: 1,
    checklist: input.checklist,
    actorItemIds: [...input.actorItemIds],
    mondayChallenge: input.mondayChallenge,
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
    snapshot.saved.mondayChallenge === input.mondayChallenge &&
    snapshot.saved.actorAnswered === input.actorAnswered;

  return zelfde
    ? { kind: 'ok', saved: snapshot.saved, token: snapshot.token }
    : { kind: 'conflict', ...snapshot };
}

/**
 * Vergelijk het token en schrijf dan. Eén script, dus er komt niets tussen.
 *
 * Geeft `{ 0, current }` bij een mismatch, zodat de aanroeper kan verzoenen zonder tweede
 * ronde — en `''` voor afwezig, want een Lua-tabel kapt af bij de eerste nil. We schrijven
 * nooit een lege string, dus die twee zijn niet te verwarren.
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

export function createUpstashChecklistStore(
  redis: Redis,
  now: () => Date = () => new Date()
): ChecklistStore {
  return {
    async read(mondayItemId) {
      const raw = await redis.get<string | null>(storeKey(mondayItemId));
      return snapshotOf(raw === undefined ? null : raw);
    },

    async save(mondayItemId, input) {
      const next = encodeRecord(input, now().toISOString());
      const res = await redis.eval(
        LUA_CAS,
        [storeKey(mondayItemId)],
        [input.token, next, ABSENT_TOKEN, String(CHECKLIST_TTL_MS)]
      );
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error('checklist store: onverwacht antwoord van het script');
      }
      const [won, value] = res;
      const current = value === '' ? null : String(value);
      if (won === 1) {
        return { kind: 'ok', saved: { ...input }, token: tokenOf(current) };
      }
      return reconcile(current, input);
    },
  };
}

/** Een store in het geheugen, voor tests en voor draaien zonder Redis. */
export function createMemoryChecklistStore(now: () => Date = () => new Date()): ChecklistStore {
  const rows = new Map<string, string>();
  return {
    read(mondayItemId) {
      return Promise.resolve(snapshotOf(rows.get(storeKey(mondayItemId)) ?? null));
    },
    save(mondayItemId, input) {
      const key = storeKey(mondayItemId);
      const current = rows.get(key) ?? null;
      if (tokenOf(current) !== input.token) {
        return Promise.resolve(reconcile(current, input));
      }
      const next = encodeRecord(input, now().toISOString());
      rows.set(key, next);
      return Promise.resolve({ kind: 'ok', saved: { ...input }, token: tokenOf(next) });
    },
  };
}
