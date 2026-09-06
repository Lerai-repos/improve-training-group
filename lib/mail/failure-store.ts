import { z } from 'zod';

import type { KvStore } from '@lib/recommend/kv';
import type { MailVariant } from './sent-store';

/**
 * Welke mails niet verstuurd zijn, zodat de dagelijkse controle ze kan melden.
 *
 * ## Waarom via KV en niet rechtstreeks naar het Systeem-bord
 *
 * `docs/build/01-architectuur.md:73` staat er duidelijk over: *"Geen gelijktijdige writes —
 * dat kan de data corrumperen. Eén worker per board."* De dagelijkse controle heeft daar een
 * grendel voor. Zou de rapportagejob óók rijen op dat bord gaan schrijven, dan zijn er twee
 * schrijvers en is die grendel niets meer waard — en de tweede schrijver zou bovendien buiten
 * de verzoening om werken, dus zijn meldingen zouden nooit vanzelf opgeruimd worden.
 *
 * Daarom laat de rapportagejob alleen een spoor achter, en maakt de controle er 's ochtends
 * een melding van. Dat levert het afvinken, het heropenen en het automatisch oplossen gratis
 * op: verdwijnt de sleutel omdat een herstelrun de mail alsnog verstuurde, dan verdwijnt de
 * melding bij de volgende controle vanzelf.
 */

/**
 * De sleutels dragen dezelfde bestemmingsruimte als de verzendgrendel.
 *
 * Zonder dat lekt een omgeleide TEST in de productiemeldingen — en erger: een geslaagde
 * herstelrun naar een testadres zou een échte openstaande mislukking wegpoetsen, terwijl er
 * naar `aanvragen@` en `backoffice@` nog steeds niets is gegaan. De grendel had die scheiding
 * al; deze store hoort hem net zo goed te hebben.
 *
 * De dagelijkse controle leest zonder ruimte, en ziet dus alleen de echte.
 */
const indexKey = (namespace: string): string => `evalmail:failed:${namespace}index`;
const detailKey = (namespace: string, id: string): string => `evalmail:failed:${namespace}${id}`;

/**
 * Deze sleutels verlopen NIET, en dat is met opzet.
 *
 * Er stond eerst dertig dagen op. Dat leek netjes, en het was precies de stille misser waar
 * deze hele meldingsketen tegen bedoeld is: verliep het detail, dan vond `list()` een
 * verwijzing naar niets, ruimde die op, en zag de dagelijkse controle geen melding meer — dus
 * verzoende hij hem weg als opgelost, terwijl de mail nooit verstuurd was. Een vergissing die
 * pas ná dertig dagen zichtbaar wordt en er dan uitziet als "het is opgelost".
 *
 * Onbegrensd groeien kan niet: `clear()` haalt ze weg zodra de mail alsnog weggaat, en wat
 * blijft staan hóórt te blijven staan, want dat is een mail die nog steeds mist. Eviction
 * staat op deze Redis uit (zie het geheugen `itg-infra-upstash-vercel`), dus een sleutel
 * zonder vervaltijd verdwijnt ook niet uit zichzelf.
 */

/** Hoeveel er hoogstens uit de index komt; een langere lijst is zelf het probleem. */
export const MAX_FAILURES = 200;

const failureSchema = z.object({
  itemId: z.string(),
  variant: z.union([z.literal('met'), z.literal('zonder')]),
  klanttitel: z.string(),
  datum: z.string(),
  reden: z.string(),
  atMs: z.number(),
});

export type MailFailure = z.infer<typeof failureSchema>;

const memberOf = (itemId: string, variant: MailVariant): string => `${itemId}:${variant}`;

/**
 * Eén opgeslagen melding, of `null` als er niets bruikbaars staat.
 *
 * `JSON.parse` WERPT bij kapotte tekst, en dat deed hij hier buiten elke afvangst: één
 * beschadigde waarde liet de hele `list()` omvallen, waarna de dagelijkse controle er één
 * algemene storing van maakte en élke afzonderlijke melding over een niet-verstuurde mail van
 * het bord verdween. Per waarde afvangen dus, en verder net zo behandelen als een ontbrekende:
 * afgeslankt melden in plaats van laten verdwijnen.
 */
function lees(waarde: string | null): MailFailure | null {
  if (waarde === null) {
    return null;
  }
  try {
    const parsed = failureSchema.safeParse(JSON.parse(waarde));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Wat er nog te melden valt als alleen de indexverwijzing over is. */
function degraded(member: string): MailFailure {
  const scheiding = member.lastIndexOf(':');
  const itemId = scheiding === -1 ? member : member.slice(0, scheiding);
  const staart = member.slice(scheiding + 1);
  return {
    itemId,
    variant: staart === 'zonder' ? 'zonder' : 'met',
    klanttitel: '(details niet meer beschikbaar)',
    datum: '(onbekend)',
    reden: 'de melding staat er nog, maar de bijzonderheden zijn niet meer te lezen',
    atMs: 0,
  };
}

export interface FailureStore {
  record(failure: MailFailure): Promise<void>;
  /** Weghalen zodra dezelfde mail alsnog is verstuurd. */
  clear(itemId: string, variant: MailVariant): Promise<void>;
  list(): Promise<readonly MailFailure[]>;
}

export function createFailureStore(
  kv: KvStore,
  namespace = '',
  nowMs: () => number = Date.now
): FailureStore {
  const INDEX = indexKey(namespace);
  const detail = (id: string): string => detailKey(namespace, id);

  return {
    async record(failure) {
      const member = memberOf(failure.itemId, failure.variant);
      await kv.set(detail(member), JSON.stringify(failure));
      await kv.zadd(INDEX, failure.atMs, member);
    },

    async clear(itemId, variant) {
      const member = memberOf(itemId, variant);
      await kv.zrem(INDEX, member);
      await kv.del(detail(member));
    },

    async list() {
      const members = await kv.zRangeByScore(INDEX, nowMs(), MAX_FAILURES);
      if (members.length === 0) {
        return [];
      }
      const rauw = await kv.mget(members.map(detail));
      const out: MailFailure[] = [];
      for (const [i, waarde] of rauw.entries()) {
        const parsed = lees(waarde);
        if (parsed !== null) {
          out.push(parsed);
          continue;
        }
        /**
         * Details weg of onleesbaar — de melding blijft, in afgeslankte vorm.
         *
         * Overslaan zou de melding laten verdwijnen en de controle hem laten verzoenen als
         * opgelost, over een mail die nog steeds niet verstuurd is. Liever een melding die
         * minder weet dan geen melding: itemnummer en variant staan in de index zelf, en dat
         * is genoeg om de juiste training terug te vinden.
         */
        out.push(degraded(members[i]));
      }
      return out;
    },
  };
}
