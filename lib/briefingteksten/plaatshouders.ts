import type { Plaatshouder } from './types';

/**
 * De plaatshouders: `{merk}`, `{trainers}`, en zo verder.
 *
 * Accolades, net als `{organisatie}` in de concept-inhoud op het Thema's-bord, zodat ITG één
 * notatie leert. Hoofdletters en spaties binnen de accolades tellen niet: `{ Merk }` is
 * `{merk}`. Dat is de vergissing die iemand maakt zonder dat hij iets anders bedoelt.
 */

/** Overal toegestaan: het label van de training bepaalt ze. */
export const OVERAL: readonly Plaatshouder[] = ['merk', 'term'];

const TOKEN = /\{([^{}]*)\}/g;

const sleutelVan = (binnen: string): string => binnen.trim().toLowerCase();

/** Wat er aan een tekst mankeert, of `null` als elke plaatshouder hier mag. */
export function controleerPlaatshouders(
  tekst: string,
  toegestaan: readonly Plaatshouder[]
): string | null {
  const mag = new Set<string>([...OVERAL, ...toegestaan]);
  const onbekend: string[] = [];
  for (const match of tekst.matchAll(TOKEN)) {
    if (!mag.has(sleutelVan(match[1] ?? ''))) {
      onbekend.push(match[0]);
    }
  }
  if (onbekend.length > 0) {
    const lijst = [...new Set(onbekend)].join(', ');
    return (
      `${onbekend.length === 1 ? 'Onbekende plaatshouder' : 'Onbekende plaatshouders'} ` +
      `${lijst}. Hier kan: ${[...mag].map((p) => `{${p}}`).join(', ')}.`
    );
  }
  // Wat na het weghalen van de geldige plaatshouders nog aan accolades over is, hoort nergens bij.
  if (/[{}]/.test(tekst.replace(TOKEN, ''))) {
    return 'Losse accolade: een plaatshouder schrijf je als {merk}, met een { en een }.';
  }
  return null;
}

/**
 * Vult de plaatshouders in.
 *
 * Een plaatshouder zonder waarde blijft staan zoals hij staat. Dat komt alleen voor als de
 * aanroeper een waarde vergeet mee te geven, en dan is `{trainers}` in het document beter te
 * zien dan een zin met een gat erin.
 */
export function vulIn(tekst: string, waarden: Partial<Record<Plaatshouder, string>>): string {
  const bekend: ReadonlyMap<string, string> = new Map(
    Object.entries(waarden).filter((e): e is [string, string] => typeof e[1] === 'string')
  );
  return tekst.replace(TOKEN, (heel, binnen: string) => bekend.get(sleutelVan(binnen)) ?? heel);
}

/** Of deze plaatshouder in de tekst voorkomt, in welke schrijfwijze ook. */
export function bevat(tekst: string, plaatshouder: Plaatshouder): boolean {
  return [...tekst.matchAll(TOKEN)].some((m) => sleutelVan(m[1] ?? '') === plaatshouder);
}
