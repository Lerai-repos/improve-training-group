import { createHash, randomUUID } from 'node:crypto';

/**
 * Alleen de twee bewerkingen die deze grendel nodig heeft.
 *
 * Smal opgeschreven en niet `Redis` zelf: dat type draagt meer dan honderdzeventig methoden,
 * en een testdubbel ervan kan alleen met een cast bestaan — juist daar waar zichtbaar hoort
 * te zijn dat de vorm klopt. De echte client past hier gewoon in.
 */
export interface SentStoreRedis {
  set(
    key: string,
    value: string,
    opts: { readonly nx: true; readonly px: number }
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * De grendel tegen dubbel verzenden.
 *
 * Het bijwerken van het agendabord is uit zichzelf idempotent: dezelfde waarde twee keer
 * zetten is een no-op, en daarom draagt die schrijfactie bewust géén idempotency-sleutel.
 * **Een mail is dat niet.** Een herstelrun over dezelfde dag, of twee croneraanroepen die
 * elkaar overlappen, zou elke accountmanager een tweede keer dezelfde aftersalesmail sturen.
 *
 * ## Twee fasen, niet één
 *
 * Er wordt eerst een KORTE claim gezet en pas ná een geslaagde verzending een LANGE. Dat
 * verschil is het hele punt. Zou de claim meteen 180 dagen gelden, dan is elke afbreking
 * tussen claimen en versturen — Vercel dat de functie afkapt, een crash, een deploy midden in
 * de run — een mail die een half jaar lang als verstuurd geldt zonder ooit verstuurd te zijn.
 * Dat is precies de storing die niemand opmerkt, want er komt geen foutmelding: er komt
 * niets.
 *
 * Met een korte claim herstelt zo'n afbreking zichzelf: de volgende run treft een verlopen
 * claim aan en probeert het opnieuw. De prijs is dat een afbreking ná het verzenden maar vóór
 * het bevestigen een dubbele mail kan opleveren, in ITG's eigen postbus. Zichtbaar en te
 * herstellen, tegenover onzichtbaar en verloren.
 *
 * ## En daarom draagt elke claim een eigenaar
 *
 * Een korte claim kán verlopen terwijl de verzending nog loopt — het handmatige script geeft
 * zijn Graph-aanroepen geen looptijdgrens mee, dus een hangende upload kan het kwartier
 * overschrijden. Dan claimt een tweede run dezelfde mail, en zou de eerste bij thuiskomst
 * andermans claim overschrijven of weggooien: `confirm` zet er dan "verstuurd" overheen
 * terwijl de tweede run nog bezig is, en `release` maakt de plek vrij terwijl een ander hem
 * bezet houdt.
 *
 * Vandaar een token per claim en vergelijken-en-dan-schrijven in één Lua-script, hetzelfde
 * patroon als `lib/briefing/checklist-store.ts`. Wie de claim kwijt is raakt de sleutel niet
 * meer aan en zegt dat.
 *
 * ## De sleutel draagt de variant, niet de datum
 *
 * Draait een dag opnieuw omdat de reacties alsnog binnengekomen zijn, dan is de uitkomst
 * veranderd van `zonder` naar `met` en hóórt die tweede mail eruit te gaan, met het rapport
 * erbij. Zat er op datum gesleuteld, dan zou die correctie geblokkeerd worden; zat er niets
 * op, dan kwam dezelfde mail elke herstelrun opnieuw.
 */

export type MailVariant = 'met' | 'zonder';

/** Ruim langer dan enige herstelrun, en korter dan voor altijd. */
export const SENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Hoe lang een lopende verzending de plek bezet houdt.
 *
 * Ruim boven de looptijd van de route (300 s) zodat twee overlappende runs elkaar echt
 * uitsluiten, en kort genoeg dat een afgekapte run binnen een kwartier vanzelf herstelt in
 * plaats van een half jaar te blokkeren.
 */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * Waar deze verzending heen ging, in acht tekens.
 *
 * Zonder dit deelt een omgeleide TEST dezelfde sleutel als de echte verzending, en dan
 * blokkeert één geslaagde test naar je eigen adres de levering aan `aanvragen@` en
 * `backoffice@` voor 180 dagen. Precies het eerste wat iemand doet met deze code.
 *
 * Alleen bij een omleiding, zodat de productiesleutels blijven zoals ze zijn: zou het
 * profiel er altijd in zitten, dan zet één hernoemde postbus elke bestaande markering op
 * losse schroeven.
 */
export function deliveryNamespace(recipients: {
  readonly klant: string;
  readonly trainer: string;
  readonly redirected: boolean;
}): string {
  if (!recipients.redirected) {
    return '';
  }
  const digest = createHash('sha256')
    .update(`${recipients.klant}|${recipients.trainer}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return `test-${digest}:`;
}

/**
 * Het bewijs dat déze run de claim heeft. Ondoorzichtig; geef hem terug, lees hem nooit uit.
 */
export type ClaimToken = string;

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly token: ClaimToken }
  /**
   * De plek is bezet, en het maakt uit WAAROM.
   *
   * `verstuurd` betekent dat de mail aantoonbaar is aangekomen; alles wat er nog over hem in
   * de administratie staat is achterstallig en mag opgeruimd worden. `bezig` betekent dat een
   * andere run er op dit moment mee doende is, en dan hoort niemand iets aan te raken.
   *
   * Dat onderscheid was er niet, en daardoor kon een melding "mail mislukt" eeuwig blijven
   * staan: het opruimen ervan gebeurde alleen op het pad dat verstuurt, en dat pad wordt na
   * een geslaagde verzending nooit meer gelopen.
   */
  | { readonly kind: 'bezet'; readonly reden: 'bezig' | 'verstuurd' };

/** Of de sleutel nog van ons was toen we hem wilden bijwerken. */
export type OwnershipResult = 'ok' | 'verloren';

export interface SentGuard {
  /** Claim het recht om te verzenden, met een token om het later te bewijzen. */
  claim(itemId: string, variant: MailVariant, nowMs: number): Promise<ClaimResult>;
  /** De verzending is gelukt; leg dat duurzaam vast, mits de claim nog van ons is. */
  confirm(
    itemId: string,
    variant: MailVariant,
    token: ClaimToken,
    nowMs: number
  ): Promise<OwnershipResult>;
  /** Geef de claim terug nadat het verzenden is mislukt, mits hij nog van ons is. */
  release(itemId: string, variant: MailVariant, token: ClaimToken): Promise<OwnershipResult>;
}

/**
 * Vergelijk het token en schrijf dan, of vergelijk en verwijder. Eén script, dus er komt
 * niets tussen.
 *
 * `ARGV[2]` leeg betekent verwijderen. Een lege waarde wordt nooit weggeschreven, dus die
 * twee zijn niet te verwarren.
 */
export const LUA_OWNED_WRITE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
end
return 1
`;

/**
 * Claimen vóór het verzenden, niet erna.
 *
 * Erna claimen laat precies het gat open waar dit voor bestaat: twee gelijktijdige runs zien
 * allebei niets, versturen allebei, en schrijven daarna allebei hetzelfde vinkje.
 */
export function createSentGuard(
  redis: SentStoreRedis,
  namespace = '',
  newToken: () => string = randomUUID
): SentGuard {
  const sleutel = (itemId: string, variant: MailVariant): string =>
    `evalmail:v1:${namespace}${itemId}:${variant}`;

  const VERSTUURD = 'verstuurd:';

  const eigenSchrijving = async (
    key: string,
    token: ClaimToken,
    waarde: string,
    ttlMs: number
  ): Promise<OwnershipResult> => {
    const res = await redis.eval(LUA_OWNED_WRITE, [key], [token, waarde, String(ttlMs)]);
    return res === 1 ? 'ok' : 'verloren';
  };

  return {
    async claim(itemId, variant, nowMs) {
      const key = sleutel(itemId, variant);
      const token = `${nowMs}:${newToken()}`;
      const gezet = await redis.set(key, token, { nx: true, px: CLAIM_TTL_MS });
      if (gezet !== null) {
        return { kind: 'claimed', token };
      }
      /**
       * Alleen op het bezette pad een extra leesactie, en alleen om te weten wát er staat.
       *
       * Is de sleutel intussen tóch verlopen (`null`), dan gaan we uit van `bezig`: dat is de
       * voorzichtige lezing, want daarop wordt niets opgeruimd.
       */
      const huidig = await redis.get(key);
      return {
        kind: 'bezet',
        reden: huidig !== null && huidig.startsWith(VERSTUURD) ? 'verstuurd' : 'bezig',
      };
    },
    /**
     * Overschrijven en niet opnieuw claimen: de sleutel staat er al, van deze run zelf, en die
     * moet juist een andere waarde en een andere TTL krijgen — dat is wat "kort" in "duurzaam"
     * verandert.
     */
    confirm: (itemId, variant, token, nowMs) =>
      eigenSchrijving(sleutel(itemId, variant), token, `${VERSTUURD}${nowMs}`, SENT_TTL_MS),
    release: (itemId, variant, token) =>
      eigenSchrijving(sleutel(itemId, variant), token, '', CLAIM_TTL_MS),
  };
}
