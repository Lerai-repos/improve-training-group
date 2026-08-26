import { createAddressFormatter } from '@lib/recommend/address';
import { createOpenRouterCompletion } from '@lib/recommend/completion';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { createGoogleRoutesTransport, createRoutesProvider } from '@lib/recommend/travel';
import {
  createKvTravelCacheStore,
  createMemoryTravelCacheStore,
  createTravelCache,
} from '@lib/recommend/travel-cache';
import { loadSettingsOnce } from '@lib/settings/load';

import { readHistorie } from './historie';
import { readTrainerAddresses, resolveBriefingTravel } from './reis';
import { readExtraInfo } from './updates';

import type { GenerateContext } from './generate';
import type { TravelInput } from './format';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { BriefingTraining } from './types';

/**
 * Alles wat er van buiten bij moet voordat er een document gemaakt kan worden.
 *
 * Eén plek, gedeeld door de app-tab en `scripts/briefing-generate.ts`. Ze moeten hetzelfde
 * document opleveren, en twee bouwsels die "hetzelfde" lezen lopen uit elkaar zodra er één
 * wordt aangepast — dan blijkt het script iets te bewijzen wat de knop niet doet.
 */

/** Wat er misging zonder dat het de briefing tegenhoudt; de aanroeper mag het tonen. */
export interface ContextNote {
  readonly kind: 'geen_reis' | 'geen_cache' | 'updates_afgekapt';
  readonly tekst: string;
}

export interface ContextResult {
  readonly context: GenerateContext;
  readonly notes: readonly ContextNote[];
}

export interface ContextInput {
  readonly actorItemIds: readonly string[];
  readonly mondayChallenge: boolean;
  /** De ontvangers waarvoor km en reistijd nodig zijn. */
  readonly trainerItemIds: readonly string[];
  /** Hoeveel eerdere/komende sessies het blok `Vaste klant` toont. */
  readonly historieLimit?: number;
}

/**
 * Km en reistijd, of niets.
 *
 * Ontbreekt een sleutel, dan gaat de briefing gewoon door zónder kilometers — er staat dan
 * een zichtbare regel in het document in plaats van een verzonnen getal. De briefing
 * tegenhouden omdat Google onbereikbaar is zou een document van vijf pagina's kosten voor
 * één regel die de trainer zelf kan opzoeken.
 */
async function resolveReis(
  client: MondayGraphQLClient,
  training: BriefingTraining,
  itemIds: readonly string[],
  notes: ContextNote[]
): Promise<ReadonlyMap<string, TravelInput>> {
  const missend = ['OPENROUTER_API_KEY', 'GOOGLE_MAPS_API_KEY'].filter(
    (naam) => (process.env[naam] ?? '') === ''
  );
  if (missend.length > 0) {
    notes.push({
      kind: 'geen_reis',
      tekst: `Km/reistijd overgeslagen: ${missend.join(', ')} ontbreekt.`,
    });
    return new Map();
  }

  /**
   * De gedeelde routecache, of anders een cache in het geheugen.
   *
   * Niet zelf op namen van omgevingsvariabelen toetsen: `createRedisClient` accepteert zowel
   * `UPSTASH_REDIS_REST_*` als Vercels alias `KV_REST_API_*`, en alleen op die tweede kijken
   * koos stilletjes de cache in het geheugen — waarna elke briefing opnieuw betaalde voor
   * routes die de aanbevelingsengine al had opgehaald. Hem laten wérpen ís de toets.
   */
  let store;
  try {
    store = createKvTravelCacheStore(createUpstashKvStore(createRedisClient()));
  } catch {
    store = createMemoryTravelCacheStore();
    notes.push({
      kind: 'geen_cache',
      tekst: 'Geen Redis-cache: routes gelden alleen binnen deze run.',
    });
  }

  const settings = await loadSettingsOnce(client);
  const adressen = await readTrainerAddresses(client, itemIds);
  const travel = await resolveBriefingTravel(
    {
      formatter: createAddressFormatter(
        createOpenRouterCompletion(process.env.OPENROUTER_API_KEY ?? '')
      ),
      cache: createTravelCache(store),
      provider: createRoutesProvider(
        createGoogleRoutesTransport(process.env.GOOGLE_MAPS_API_KEY ?? '')
      ),
      hqAddress: settings.app.hqAddress,
      thresholdMinutes: settings.app.travelTimeThresholdMinutes,
    },
    {
      locatie: training.locatie,
      trainers: itemIds.map((id) => ({ externalItemId: id, adres: adressen.get(id) ?? null })),
    }
  );

  /**
   * Eén regel als iedereen om dezelfde reden geen km krijgt.
   *
   * Dat is meestal de locatie, en dan is het één probleem en geen acht. Acht identieke
   * meldingen onder elkaar leest als acht dingen die stuk zijn.
   */
  const redenen = new Set(travel.zonder.map((z) => z.reden));
  if (travel.zonder.length > 0 && redenen.size === 1) {
    notes.push({
      kind: 'geen_reis',
      tekst: `Geen km voor ${travel.zonder.length} trainer(s) — ${[...redenen][0]}`,
    });
  } else {
    for (const ontbreekt of travel.zonder) {
      notes.push({
        kind: 'geen_reis',
        tekst: `Geen km voor trainer ${ontbreekt.itemId} (${ontbreekt.reden}).`,
      });
    }
  }
  return travel.perTrainer;
}

export async function buildGenerateContext(
  client: MondayGraphQLClient,
  training: BriefingTraining,
  input: ContextInput
): Promise<ContextResult> {
  const notes: ContextNote[] = [];

  const extraInfo = await readExtraInfo(client, [training.itemId, training.opportunityItemId]);
  /**
   * `truncated` bestaat precies hiervoor, dus hem laten vallen is het verkeerde soort stil.
   *
   * Monday geeft een begrensd aantal updates terug. Zit een item aan die grens, dan mist de
   * achtergrondinformatie tekst — en het document ziet er compleet uit, want er ontbreekt
   * geen veld, alleen inhoud. De briefing tegenhouden is te zwaar (dit is aanvullende tekst,
   * geen kern), maar er niets over zeggen maakt van een gegevensconditie een onzichtbare.
   */
  if (extraInfo.truncated) {
    notes.push({
      kind: 'updates_afgekapt',
      tekst:
        'Monday gaf niet alle updates terug; er kan gemarkeerde tekst ontbreken in de ' +
        'achtergrondinformatie. Controleer de updates op het agenda-item en de Opportunity.',
    });
  }

  /**
   * De historie wordt áltijd gelezen, ook als de checklist er niet om vraagt.
   *
   * Het blok `Vaste klant` komt er alleen bij een vinkje, maar de adviseur moet in de tab
   * kunnen zien dát er eerdere sessies zijn vóórdat hij dat vinkje zet — anders moet hij dat
   * zelf in de agenda opzoeken, precies het werk dat dit blok hoort weg te nemen.
   */
  const historie = await readHistorie(client, {
    bedrijf: training.opdrachtgever,
    excludeItemId: training.itemId,
    limit: input.historieLimit,
  });

  const reis = await resolveReis(client, training, input.trainerItemIds, notes);

  return {
    context: {
      historie,
      extraInfo: extraInfo.lines,
      mondayChallenge: input.mondayChallenge,
      reis,
      actorItemIds: input.actorItemIds,
    },
    notes,
  };
}
