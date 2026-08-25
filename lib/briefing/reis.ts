/**
 * Km en reistijd per ontvanger.
 *
 * Dirkje, 21-Aug-2026, over waarom elke ontvanger zijn eigen document krijgt: *"De briefing
 * gaat naar mensen persoonlijk (staan ook hun eigen km's bijv in)."* Dit is dat veld.
 *
 * ## Alles hergebruikt van de aanbevelingsengine
 *
 * De engine berekent deze routes al voor elke kandidaat, dus hier wordt niets nagebouwd:
 * `resolveTravel` doet de cache, het batchen, de foutclassificatie en het verdubbelen naar
 * retour. Wij leveren alleen de herkomsten en de bestemming aan.
 *
 * **De bestemming moet door dezelfde adresformattering.** De cachesleutel is het
 * genormaliseerde adres, dus zouden we hier de rauwe `Locatie` doorgeven waar de engine
 * `decision.formatted` gebruikte, dan missen we elke leg die de engine al betaald heeft —
 * en kunnen we bovendien op een ándere route uitkomen dan de adviseur zag toen hij deze
 * trainer koos. Dat is één extra AI-aanroep per briefing, precies dezelfde die de engine
 * per run doet.
 */

import { TRAINER_COLUMNS } from '@lib/monday/board-config';

import type { AddressFormatter } from '@lib/recommend/address';
import type { TravelProvider } from '@lib/recommend/travel';
import type { TravelCache, TravelOrigin } from '@lib/recommend/travel-resolve';
import { resolveTravel } from '@lib/recommend/travel-resolve';

import type { TravelInput } from './format';

/**
 * Alleen `query`, want dat is alles wat het uitlezen van de adressen nodig heeft. Een volledige
 * `MondayGraphQLClient` voldoet hier vanzelf aan; een test hoeft er geen na te bouwen.
 */
export interface AddressRow {
  readonly id: string | number;
  readonly column_values?: ReadonlyArray<{ readonly id: string; readonly text: string | null }>;
}

export interface AddressReader {
  query(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<{ items?: readonly AddressRow[] }>;
}

export interface BriefingTravelDeps {
  readonly formatter: AddressFormatter;
  readonly cache: TravelCache;
  readonly provider: TravelProvider;
  /** Het kantooradres; `resolveTravel` heeft de HQ-leg nodig als gedeelde referentie. */
  readonly hqAddress: string;
  /** Uit de instellingen, niet uit code. Zie `formatTravel`. */
  readonly thresholdMinutes: number;
}

/**
 * Waarom een trainer geen km krijgt. Nooit een reden om de briefing tegen te houden: dan
 * zou één trainer zonder adres het document van al zijn collega's blokkeren.
 */
export interface TravelMissing {
  readonly itemId: string;
  readonly reden: string;
}

export interface BriefingTravel {
  /** Per trainer-itemId, voor iedereen bij wie een route gevonden is. */
  readonly perTrainer: ReadonlyMap<string, TravelInput>;
  readonly zonder: readonly TravelMissing[];
}

/**
 * De adressen van de trainers, van het trainersbord.
 *
 * Apart opgehaald en niet in `BriefingTrainer`: een adres komt in geen enkele briefingtekst
 * voor, alleen in deze berekening. In het type zetten zou het door elke fixture en elk blok
 * heen slepen zonder dat iemand het daar leest.
 */
export async function readTrainerAddresses(
  client: AddressReader,
  ids: readonly string[]
): Promise<Map<string, string | null>> {
  if (ids.length === 0) {
    return new Map();
  }
  const data = await client.query(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         column_values(ids: ["${TRAINER_COLUMNS.adres}"]) { id text }
       }
     }`,
    { ids: [...ids] }
  );
  const byId = new Map<string, string | null>();
  let kolomGezien = 0;
  for (const item of data.items ?? []) {
    const cel = (item.column_values ?? []).find((c) => c.id === TRAINER_COLUMNS.adres);
    if (cel !== undefined) {
      kolomGezien += 1;
    }
    byId.set(String(item.id), cel === undefined ? null : (cel.text ?? '').trim() || null);
  }

  /**
   * Schemadrift herkennen aan de **aanwezigheid van de kolom**, niet aan gevulde waarden.
   *
   * Een kolom-id die Monday niet kent wordt wéggelaten in plaats van te falen; een kolom die
   * wél bestaat maar leeg is komt terug als `{ id, text: "" }`. Gemeten 24-Aug-2026 op het
   * trainersbord: 191 trainers, waarvan er **58 een leeg adres hebben**.
   *
   * Tellen hoeveel adressen gevuld zijn is daarom de verkeerde toets. Een training waarvan
   * de trainers toevallig allemaal uit die 58 komen — één nieuwe trainer is al genoeg —
   * brak zo de héle briefing af, terwijl `resolveBriefingTravel` hen juist netjes als
   * `no_address` afhandelt en de rest van het document gewoon klopt.
   */
  if ((data.items ?? []).length > 0 && kolomGezien === 0) {
    throw new Error(
      `Briefing: het trainersbord levert kolom ${TRAINER_COLUMNS.adres} voor geen enkele ` +
        'trainer; is die hernoemd, verwijderd of van type veranderd?'
    );
  }
  return byId;
}

/**
 * Km en reistijd voor deze trainers naar deze locatie.
 *
 * Geeft nooit een fout terug voor één trainer: wie geen adres heeft of voor wie geen route
 * bestaat komt in `zonder` terecht en krijgt in het document de zichtbare `«…»`-regel. Een
 * storing die iedereen raakt (de HQ-leg, of een provider die eruit ligt) is wél een `throw`,
 * want dan zou elk document stilletjes zonder km's de deur uit gaan.
 */
export async function resolveBriefingTravel(
  deps: BriefingTravelDeps,
  input: { readonly locatie: string | null; readonly trainers: readonly TravelOrigin[] }
): Promise<BriefingTravel> {
  if (input.trainers.length === 0) {
    return { perTrainer: new Map(), zonder: [] };
  }

  const decision = await deps.formatter.format(input.locatie);

  /**
   * Een onbruikbare `Locatie` (alleen een plaatsnaam, of "ntb") kost de km's, maar niet de
   * briefing. Opnieuw proberen verandert er niets aan — alleen het veld op Monday bijwerken
   * doet dat — en de andere vijftien rijen van de gegevenstabel kloppen gewoon. Dus de
   * zichtbare `«…»`-regel, precies zoals vóórdat dit veld bestond.
   *
   * De aanbevelingsengine wérpt hier wel, en terecht: die kan zonder afstand niet prijzen.
   * Een briefing kan prima zonder.
   */
  if (decision.kind === 'unresolved_location') {
    return {
      perTrainer: new Map(),
      zonder: input.trainers.map((t) => ({
        itemId: t.externalItemId,
        reden: `locatie onbruikbaar: ${decision.detail}`,
      })),
    };
  }

  /**
   * `error` is iets anders: een model- of parsefout, en die kán de volgende keer wél lukken.
   * Stilletjes zonder km's doorgaan zou een storing als een eigenschap van de training laten
   * lijken.
   */
  if (decision.kind === 'error') {
    throw new Error(`Briefing: locatie niet te bepalen voor km/reistijd — ${decision.detail}`);
  }

  /**
   * Online: er ís geen reis. Nul is hier het eerlijke antwoord en geen ontbrekende bron —
   * `«nog niet aangesloten»` zou beweren dat we het niet weten, terwijl we het juist wél
   * weten.
   */
  if (decision.kind === 'no_travel_confirmed') {
    const nul: TravelInput = {
      roundTripKm: 0,
      roundTripMinutes: 0,
      thresholdMinutes: deps.thresholdMinutes,
    };
    return {
      perTrainer: new Map(input.trainers.map((t) => [t.externalItemId, nul])),
      zonder: [],
    };
  }

  /**
   * Niemand met een adres? Dan valt er niets te routeren, en hoeft er ook niets gebeld te
   * worden.
   *
   * `resolveTravel` lost eerst de gedeelde HQ-leg op en filtert de adresloze trainers pas
   * daarna. Zonder deze afslag kost een training waarvan iedereen een leeg adres heeft dus
   * een betaalde Google-aanroep die per definitie niets kan opleveren — en erger: een hapering
   * in die HQ-leg is een `fout`, en die zou de héle briefing afbreken voor km's die er toch
   * nooit zouden komen. Gemeten: 58 van de 191 trainers hebben geen adres, dus dit is geen
   * theoretisch geval.
   *
   * De toets is letterlijk dezelfde als die van `resolveTravel`, zodat beide paden dezelfde
   * trainers als `no_address` bestempelen.
   */
  const metAdres = input.trainers.filter((t) => (t.adres ?? '').trim() !== '');
  if (metAdres.length === 0) {
    return {
      perTrainer: new Map(),
      zonder: input.trainers.map((t) => ({ itemId: t.externalItemId, reden: 'no_address' })),
    };
  }

  const resolved = await resolveTravel(deps.cache, deps.provider, {
    destination: decision.formatted,
    hqAddress: deps.hqAddress,
    trainers: input.trainers,
  });
  if (resolved.kind === 'fout') {
    throw new Error(`Briefing: km/reistijd niet op te halen — ${resolved.detail}`);
  }

  const perTrainer = new Map<string, TravelInput>();
  for (const [itemId, reis] of resolved.byTrainer) {
    perTrainer.set(itemId, {
      roundTripKm: reis.roundTripDistanceKm,
      roundTripMinutes: reis.roundTripDurationMinutes,
      thresholdMinutes: deps.thresholdMinutes,
    });
  }
  return {
    perTrainer,
    zonder: resolved.excluded.map((e) => ({ itemId: e.externalItemId, reden: e.reason })),
  };
}
