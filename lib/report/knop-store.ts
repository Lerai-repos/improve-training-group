import { z } from 'zod';

import type { KvStore } from '@lib/recommend/kv';

/**
 * Waarom de knop Eval Rapport geen rapport kon maken, zodat de dagelijkse controle het op
 * het Systeem-bord zet.
 *
 * Via KV en niet rechtstreeks naar het bord, om dezelfde reden als bij de mislukte mails
 * (`lib/mail/failure-store.ts`): er is één schrijver op het Systeem-bord, en alleen die krijgt
 * het afvinken, heropenen en automatisch oplossen. Lukt een latere knopdruk wél, dan verdwijnt
 * de sleutel, en direct daarna de melding (`syncEvaluatieMeldingen`).
 *
 * Eén melding per training, en de laatste knopdruk wint: die zegt wat er nú mis is.
 *
 * Verloopt niet, net als de mailmeldingen: een melding die vanzelf verdwijnt wordt door de
 * controle als opgelost verzoend terwijl er nog steeds geen rapport is.
 */

const INDEX = 'evalknop:open:index';
const detail = (itemId: string): string => `evalknop:open:${itemId}`;

/** Hoeveel er hoogstens uit de index komt; een langere lijst is zelf het probleem. */
export const MAX_KNOP_PROBLEMEN = 200;

const probleemSchema = z.object({
  itemId: z.string(),
  klanttitel: z.string(),
  datum: z.string(),
  reden: z.string(),
  atMs: z.number(),
});

export type KnopProbleem = z.infer<typeof probleemSchema>;

export interface KnopProbleemStore {
  record(probleem: KnopProbleem): Promise<void>;
  /** Weghalen zodra de knop voor deze training wél lukt. */
  clear(itemId: string): Promise<void>;
  list(): Promise<readonly KnopProbleem[]>;
}

function lees(waarde: string | null): KnopProbleem | null {
  if (waarde === null) {
    return null;
  }
  try {
    const parsed = probleemSchema.safeParse(JSON.parse(waarde));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createKnopProbleemStore(
  kv: KvStore,
  nowMs: () => number = Date.now
): KnopProbleemStore {
  return {
    async record(probleem) {
      await kv.set(detail(probleem.itemId), JSON.stringify(probleem));
      await kv.zadd(INDEX, probleem.atMs, probleem.itemId);
    },

    async clear(itemId) {
      await kv.zrem(INDEX, itemId);
      await kv.del(detail(itemId));
    },

    async list() {
      const ids = await kv.zRangeByScore(INDEX, nowMs(), MAX_KNOP_PROBLEMEN);
      if (ids.length === 0) {
        return [];
      }
      const rauw = await kv.mget(ids.map(detail));
      return ids.map(
        (itemId, i) =>
          lees(rauw[i] ?? null) ?? {
            itemId,
            klanttitel: '(details niet meer beschikbaar)',
            datum: '(onbekend)',
            reden: 'de melding staat er nog, maar de bijzonderheden zijn niet meer te lezen',
            atMs: 0,
          }
      );
    },
  };
}
