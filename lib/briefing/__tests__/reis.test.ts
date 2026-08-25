import { describe, expect, it } from 'vitest';

import { formatTravel } from '../format';
import { readTrainerAddresses, resolveBriefingTravel } from '../reis';

import type { AddressDecision, AddressFormatter } from '@lib/recommend/address';
import type { RouteElement, TravelProvider } from '@lib/recommend/travel';
import type { TravelCache } from '@lib/recommend/travel-resolve';

import type { AddressReader, AddressRow } from '../reis';

/**
 * Km en reistijd per ontvanger.
 *
 * De rekenkant is niet nieuw — `resolveTravel` deed dit al voor de aanbevelingsengine — dus
 * deze tests bewaken vooral de overgangen: welke storing één trainer raakt en welke iedereen,
 * en of de bestemming door dezelfde adresformattering gaat. Dat laatste is geen detail: de
 * cachesleutel ís het genormaliseerde adres, dus de rauwe `Locatie` doorgeven zou elke leg
 * missen die de engine al betaald heeft.
 */

const formatter = (decision: AddressDecision): AddressFormatter => ({
  format: () => Promise.resolve(decision),
});

const REQUIRED: AddressDecision = {
  kind: 'travel_required',
  formatted: 'Raadhuisplein 6, 3851 NT Ermelo',
  city: 'Ermelo',
};

/** Een cache die niets kent en niets onthoudt; alles gaat dan naar de provider. */
const leegCache = (): TravelCache => ({
  lookup: () => Promise.resolve(null),
  write: () => Promise.resolve(),
});

interface ProviderCall {
  readonly origins: readonly string[];
  readonly destination: string;
}

function provider(
  antwoord: (origin: string) => RouteElement,
  calls: ProviderCall[] = []
): TravelProvider {
  return {
    routingKey: () => 'test:v1',
    distances: (origins, destination) => {
      calls.push({ origins: [...origins], destination });
      return Promise.resolve(origins.map((o) => antwoord(o)));
    },
  };
}

const ok = (distanceKm: number, durationMinutes: number): RouteElement => ({
  status: 'ok',
  leg: { distanceKm, durationMinutes },
});

const DEPS = {
  cache: leegCache(),
  hqAddress: 'Wolvenplein 25, Utrecht',
  thresholdMinutes: 90,
};

describe('resolveBriefingTravel', () => {
  it('geeft de retourafstand en -tijd per trainer', async () => {
    const uit = await resolveBriefingTravel(
      { ...DEPS, formatter: formatter(REQUIRED), provider: provider(() => ok(63, 50)) },
      { locatie: 'Ermelo', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
    );
    const reis = uit.perTrainer.get('1');
    // Eén kant 63 km / 50 min -> retour 126 km / 100 min; 10 min boven de drempel van 90.
    expect(reis).toEqual({ roundTripKm: 126, roundTripMinutes: 100, thresholdMinutes: 90 });
    expect(formatTravel(reis!)).toBe('Totaal: 126 km. / Totaal: 100 min. (10 min. factureren)');
  });

  /**
   * De bestemming gaat door de adresformattering en niet rauw naar de provider. Anders wijkt
   * de cachesleutel af van die van de aanbevelingsengine en betaalt elke briefing opnieuw
   * voor een leg die al opgehaald is — mogelijk zelfs met een andere uitkomst dan de
   * adviseur zag toen hij deze trainer koos.
   */
  it('routeert naar het geformatteerde adres, niet naar de rauwe locatie', async () => {
    const calls: ProviderCall[] = [];
    await resolveBriefingTravel(
      {
        ...DEPS,
        formatter: formatter(REQUIRED),
        provider: provider(() => ok(10, 10), calls),
      },
      { locatie: 'ermelo, raadhuisplein', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
    );
    expect(calls.every((c) => c.destination === REQUIRED.formatted)).toBe(true);
  });

  /**
   * Online: er ís geen reis. Nul is dan het eerlijke antwoord; een `«nog niet aangesloten»`
   * zou beweren dat we het niet weten terwijl we het juist wél weten.
   */
  it('geeft nul km bij een online sessie, zonder de provider te bellen', async () => {
    const calls: ProviderCall[] = [];
    const uit = await resolveBriefingTravel(
      {
        ...DEPS,
        formatter: formatter({ kind: 'no_travel_confirmed', reason: 'online' }),
        provider: provider(() => ok(99, 99), calls),
      },
      { locatie: 'Teams', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
    );
    expect(uit.perTrainer.get('1')?.roundTripKm).toBe(0);
    expect(formatTravel(uit.perTrainer.get('1')!)).toBe('Totaal: 0 km. / Totaal: 0 min.');
    expect(calls).toHaveLength(0);
  });

  /**
   * Eén trainer zonder adres houdt de briefing van zijn collega's niet tegen. Hij komt in
   * `zonder` en krijgt in zijn eigen document de zichtbare `«…»`-regel.
   */
  it('slaat een trainer zonder adres over en levert de rest wel', async () => {
    const uit = await resolveBriefingTravel(
      { ...DEPS, formatter: formatter(REQUIRED), provider: provider(() => ok(20, 30)) },
      {
        locatie: 'Ermelo',
        trainers: [
          { externalItemId: '1', adres: 'Amsterdam' },
          { externalItemId: '2', adres: null },
        ],
      }
    );
    expect(uit.perTrainer.has('1')).toBe(true);
    expect(uit.perTrainer.has('2')).toBe(false);
    expect(uit.zonder).toEqual([{ itemId: '2', reden: 'no_address' }]);
  });

  it('slaat een trainer over voor wie geen route bestaat', async () => {
    const uit = await resolveBriefingTravel(
      {
        ...DEPS,
        formatter: formatter(REQUIRED),
        provider: provider((o) => (o === 'Nergens' ? { status: 'not_found' } : ok(20, 30))),
      },
      {
        locatie: 'Ermelo',
        trainers: [
          { externalItemId: '1', adres: 'Amsterdam' },
          { externalItemId: '2', adres: 'Nergens' },
        ],
      }
    );
    expect(uit.perTrainer.has('1')).toBe(true);
    expect(uit.zonder).toEqual([{ itemId: '2', reden: 'route_not_found' }]);
  });

  /**
   * Een storing die iedereen raakt is wél fataal. Zou die per trainer worden weggeschreven,
   * dan gaat elk document zonder km's de deur uit en ziet niemand dat er iets mis was.
   */
  it('werpt als de provider eruit ligt', async () => {
    await expect(
      resolveBriefingTravel(
        {
          ...DEPS,
          formatter: formatter(REQUIRED),
          provider: provider(() => ({ status: 'transient', detail: '503' })),
        },
        { locatie: 'Ermelo', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
      )
    ).rejects.toThrow(/km\/reistijd niet op te halen/);
  });

  /**
   * Gemeten op de training `Alpine`, waar `Locatie` alleen een plaatsnaam bevat: dit wérpen
   * hield de héle briefing tegen, terwijl die er vóór dit veld gewoon uitkwam. Opnieuw
   * proberen helpt niet — alleen het veld op Monday bijwerken doet dat.
   */
  it('laat de briefing door als de locatie onbruikbaar is, zonder km', async () => {
    const uit = await resolveBriefingTravel(
      {
        ...DEPS,
        formatter: formatter({ kind: 'unresolved_location', detail: 'alleen een plaatsnaam' }),
        provider: provider(() => ok(1, 1)),
      },
      { locatie: 'Amersfoort', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
    );
    expect(uit.perTrainer.size).toBe(0);
    expect(uit.zonder[0]?.reden).toContain('alleen een plaatsnaam');
  });

  /** Een model- of parsefout kán de volgende keer wél lukken, dus die mag niet verdwijnen. */
  it('werpt bij een storing in de adresbepaling', async () => {
    await expect(
      resolveBriefingTravel(
        {
          ...DEPS,
          formatter: formatter({ kind: 'error', detail: 'model gaf geen JSON' }),
          provider: provider(() => ok(1, 1)),
        },
        { locatie: 'Ermelo', trainers: [{ externalItemId: '1', adres: 'Amsterdam' }] }
      )
    ).rejects.toThrow(/locatie niet te bepalen/);
  });

  /**
   * `resolveTravel` doet de gedeelde HQ-leg vóórdat het de adresloze trainers eruit filtert.
   * Zonder afslag kost dit dus een betaalde aanroep die per definitie niets oplevert, en zou
   * een hapering in die leg de briefing afbreken voor km's die er toch nooit komen. Gemeten:
   * 58 van de 191 trainers hebben geen adres.
   */
  it('belt de provider niet als niemand een adres heeft', async () => {
    const calls: ProviderCall[] = [];
    const uit = await resolveBriefingTravel(
      { ...DEPS, formatter: formatter(REQUIRED), provider: provider(() => ok(10, 10), calls) },
      {
        locatie: 'Ermelo',
        trainers: [
          { externalItemId: '1', adres: null },
          { externalItemId: '2', adres: '   ' },
        ],
      }
    );
    expect(calls).toHaveLength(0);
    expect(uit.zonder).toEqual([
      { itemId: '1', reden: 'no_address' },
      { itemId: '2', reden: 'no_address' },
    ]);
  });

  /** Eén adres is genoeg om wél te routeren; de adresloze buurman komt in `zonder`. */
  it('routeert wel zodra één trainer een adres heeft', async () => {
    const calls: ProviderCall[] = [];
    const uit = await resolveBriefingTravel(
      { ...DEPS, formatter: formatter(REQUIRED), provider: provider(() => ok(10, 10), calls) },
      {
        locatie: 'Ermelo',
        trainers: [
          { externalItemId: '1', adres: null },
          { externalItemId: '2', adres: 'Kerkstraat 1' },
        ],
      }
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(uit.perTrainer.has('2')).toBe(true);
    expect(uit.zonder).toEqual([{ itemId: '1', reden: 'no_address' }]);
  });

  it('belt niemand als er geen trainers zijn', async () => {
    const calls: ProviderCall[] = [];
    const uit = await resolveBriefingTravel(
      { ...DEPS, formatter: formatter(REQUIRED), provider: provider(() => ok(1, 1), calls) },
      { locatie: 'Ermelo', trainers: [] }
    );
    expect(uit.perTrainer.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('readTrainerAddresses', () => {
  const client = (items: readonly AddressRow[]): AddressReader => ({
    query: () => Promise.resolve({ items }),
  });

  it('leest het adres per trainer', async () => {
    const uit = await readTrainerAddresses(
      client([{ id: 1, column_values: [{ id: 'adres__1', text: 'Kerkstraat 1, Utrecht' }] }]),
      ['1']
    );
    expect(uit.get('1')).toBe('Kerkstraat 1, Utrecht');
  });

  it('leest een leeg adres als null', async () => {
    const uit = await readTrainerAddresses(
      client([
        { id: 1, column_values: [{ id: 'adres__1', text: '  ' }] },
        { id: 2, column_values: [{ id: 'adres__1', text: 'Kerkstraat 1' }] },
      ]),
      ['1', '2']
    );
    expect(uit.get('1')).toBeNull();
  });

  /**
   * Gemeten op het trainersbord, 24-Aug-2026: 191 trainers, waarvan er **58 een leeg adres
   * hebben**. Een training waarvan de trainers toevallig allemaal uit die 58 komen — één
   * nieuwe trainer volstaat — mag de briefing niet afbreken. Ze horen door te stromen als
   * `no_address`, met een zichtbare regel in hún document en km's voor de rest.
   */
  it('breekt niet af als iedereen een leeg adres heeft', async () => {
    const uit = await readTrainerAddresses(
      client([
        { id: 1, column_values: [{ id: 'adres__1', text: '' }] },
        { id: 2, column_values: [{ id: 'adres__1', text: '   ' }] },
      ]),
      ['1', '2']
    );
    expect(uit.get('1')).toBeNull();
    expect(uit.get('2')).toBeNull();
  });

  /**
   * De kolom zelf ontbreekt — dát is schemadrift. Monday laat een kolom-id die het niet kent
   * wég in plaats van te falen, dus zonder deze controle levert een hernoemde kolom stilletjes
   * briefings zonder km's op. Een lege cel komt wél terug, als `{ id, text: "" }`, en dat is
   * precies het onderscheid dat deze twee tests bewaken.
   */
  it('werpt als de adreskolom bij niemand terugkomt', async () => {
    await expect(
      readTrainerAddresses(client([{ id: 1, column_values: [] }]), ['1'])
    ).rejects.toThrow(/hernoemd, verwijderd of van type veranderd/);
  });

  /** Eén trainer met adres bewijst dat de kolom bestaat; de lege buurman is dan gewoon leeg. */
  it('werpt niet als de kolom bij minstens één trainer terugkomt', async () => {
    const uit = await readTrainerAddresses(
      client([
        { id: 1, column_values: [{ id: 'adres__1', text: '' }] },
        { id: 2, column_values: [{ id: 'adres__1', text: 'Kerkstraat 1' }] },
      ]),
      ['1', '2']
    );
    expect(uit.get('1')).toBeNull();
    expect(uit.get('2')).toBe('Kerkstraat 1');
  });

  it('vraagt niets op zonder trainers', async () => {
    let gebeld = false;
    const uit = await readTrainerAddresses(
      {
        query: () => {
          gebeld = true;
          return Promise.resolve({ items: [] });
        },
      },
      []
    );
    expect(uit.size).toBe(0);
    expect(gebeld).toBe(false);
  });
});
