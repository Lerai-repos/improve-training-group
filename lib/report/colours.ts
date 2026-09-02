/**
 * De grafiekkleuren worden AFGELEID van de merkkleur, niet apart geconfigureerd.
 *
 * Dat is een bewuste keuze uit de bestaande generator en hij blijft: ITG kiest één kleur per
 * label en alles in het rapport volgt. Een tweede en derde kleur laten instellen zou een label
 * kunnen opleveren waarvan de taartpunten niet bij de balken passen, en dat merkt niemand tot
 * het bij een klant op de mat ligt.
 */

/** Percentage lichter voor de drie afgeleide tinten. Overgenomen uit `build-html-code.js`. */
const MID = 0.4;
const LIGHT = 0.6;
const LIGHTEST = 0.8;

const HEX_BASE = 16;
const CHANNEL_MAX = 255;

export interface ChartColours {
  /** De merkkleur zelf: balk-omtrek, koptekst, iconen. */
  readonly brand: string;
  /** Balken en de taartpunt "Ja". */
  readonly mid: string;
  /** "Nee". */
  readonly light: string;
  /** "Anders". */
  readonly lightest: string;
}

/**
 * Meng `amount` van wit door de kleur.
 *
 * Letterlijk de rekenwijze uit de bestaande generator, inclusief `Math.round` per kanaal —
 * de rapporten die ITG vandaag verstuurt zien er zo uit, en een "nettere" formule zou elk
 * bestaand rapport net iets anders maken zonder dat iemand daarom heeft gevraagd.
 */
export function lighten(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), HEX_BASE);
  const g = parseInt(hex.slice(3, 5), HEX_BASE);
  const b = parseInt(hex.slice(5, 7), HEX_BASE);
  const mix = (channel: number): number => Math.round(channel + (CHANNEL_MAX - channel) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(HEX_BASE).padStart(2, '0')).join('')}`;
}

export function chartColours(brand: string): ChartColours {
  return {
    brand,
    mid: lighten(brand, MID),
    light: lighten(brand, LIGHT),
    lightest: lighten(brand, LIGHTEST),
  };
}
