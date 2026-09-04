import type { KvStore } from '@lib/recommend/kv';

/**
 * Eén run tegelijk op het Systeem-bord.
 *
 * `docs/build/01-architectuur.md:73` legt de regel vast die uit Monday's eigen documentatie
 * komt: *"Geen gelijktijdige writes — dat kan de data corrumperen. Eén worker per board,
 * geserialiseerd."*
 *
 * Zonder deze grendel is het volgende mogelijk, en het is niet theoretisch: de cron vuurt om
 * 03:15 terwijl iemand `pnpm daily:check --apply` draait, of Vercel probeert een cron opnieuw.
 * Beide runs lezen het bord, zien melding X niet staan, en maken hem allebei aan. De
 * idempotency-sleutel houdt dat níét tegen — die bevat het run-id, juist zodat een látere run
 * een verwijderde melding opnieuw mag plaatsen, en twee runs hebben dus twee verschillende
 * sleutels voor dezelfde rij.
 *
 * **Bij tegenstand wachten we niet, we slaan over.** Een dagelijkse controle die tien minuten
 * staat te wachten tot een andere klaar is levert niets op: die andere doet exact hetzelfde
 * werk en laat hetzelfde bord achter. Wachten zou alleen de looptijdgrens van de route opeten.
 */

/** Ruim boven de gemeten looptijd (~40 s). */
export const LEASE_TTL_MS = 300_000;

/**
 * Hoe lang een run mag duren voordat hij de grendel niet meer mag opruimen.
 *
 * Ruim onder de TTL. Elke aanroeper hoort zijn Monday-clients een deadline mee te geven die
 * hieronder ligt — `RUN_DEADLINE_MS` in de croneroute en in het script doen dat — zodat een
 * gezonde run hier nooit langs komt. Deze grens is de vangnet-variant voor het geval dat toch
 * gebeurt.
 */
const SAFE_RELEASE_MS = LEASE_TTL_MS / 2;

export type LeaseOutcome<R> =
  | { readonly kind: 'ran'; readonly value: R }
  /** Een andere run had de grendel; deze heeft niets gedaan. */
  | { readonly kind: 'busy' };

export interface LeaseDeps {
  readonly kv: KvStore;
  /** Uniek per poging. Alleen de houder mag vrijgeven. */
  readonly token: () => string;
  /** Voor de vrijgavecontrole hieronder. Injecteerbaar zodat een test hem vast kan zetten. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const lockKey = (boardId: string): string => `signals:lease:${boardId}`;

/**
 * Draait `body` alleen als deze aanroeper de grendel krijgt.
 *
 * **Vrijgeven mag alleen als we zeker weten dat de grendel nog van ons is, en dat is een
 * kwestie van tijd, niet van teruglezen.**
 *
 * Teruglezen-dan-verwijderen lijkt veilig maar is het niet: tussen de `get` en de `del` kan de
 * sleutel verlopen en kan een volgende run hem pakken, waarna wij díéns grendel weghalen en er
 * een derde schrijver bij kan. Een echte compare-and-delete zou dat sluiten, maar die vraagt om
 * een Lua-script en dus om een nieuwe methode op `KvStore` — een gedeelde abstractie die ook de
 * aanbevelingsmotor gebruikt.
 *
 * Dit is even sluitend en blijft binnen dit bestand: verwijder alleen als er zoveel minder tijd
 * verstreken is dan de TTL dat de sleutel onmogelijk verlopen kan zijn. Bij `SAFE_RELEASE_MS`
 * van de helft is de marge anderhalve minuut — ruim buiten elk klokverschil tussen ons en Redis.
 *
 * Duurde de run langer, dan laten we de grendel gewoon verlopen. Dat kost hooguit wat wachttijd
 * voor de volgende run, en dat is de goede kant om op te falen.
 */
export async function withBoardLease<R>(
  deps: LeaseDeps,
  boardId: string,
  body: () => Promise<R>
): Promise<LeaseOutcome<R>> {
  const key = lockKey(boardId);
  const token = deps.token();
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? LEASE_TTL_MS;

  const mine = await deps.kv.setIfAbsent(key, token, { ttlMs });
  if (!mine) {
    return { kind: 'busy' };
  }

  const acquiredAt = now();
  try {
    return { kind: 'ran', value: await body() };
  } finally {
    if (now() - acquiredAt < Math.min(SAFE_RELEASE_MS, ttlMs / 2)) {
      await deps.kv.del(key);
    }
  }
}
