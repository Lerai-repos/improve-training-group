import { resolveLabelCode } from './catalog';

/**
 * Een nieuw label op het Labels-bord ook in de keuzelijsten zetten: `Label` op de Opportunity en
 * `status23` op elk actief agendabord.
 *
 * Zonder dit moet ITG een label op drie plekken met de hand aanmaken, met precies dezelfde naam;
 * één tikfout en het label werkt nergens. Nu zetten ze één rij neer en volgt de rest.
 *
 * **Alleen toevoegen.** Nooit hernoemen of verwijderen: de waarde van een training verwijst naar
 * het label-id, en een verdwenen label maakt die waarde leeg. Een tikfout in een rijnaam laat dus
 * een overbodig label achter, en dat ruimt ITG met de hand op.
 *
 * **Waarom zo voorzichtig.** Monday's `update_status_column` vraagt de HELE lijst labels, met
 * kleur als naam (`done_green`), terwijl de kolom ze als nummer teruggeeft. Een verkeerde
 * vertaling kleurt elk bestaand label om, op een bord dat ITG elke dag gebruikt. Daarom:
 * `planKeuzelijst` weigert een kleur die het niet kent, en `controleerNa` vergelijkt na het
 * schrijven elk label met hoe het ervoor was.
 */

/** Monday's statuskleuren: nummer in de kolominstellingen → naam in `StatusColumnColors`. */
export const STATUS_KLEUR: Readonly<Record<number, string>> = {
  0: 'working_orange',
  1: 'done_green',
  2: 'stuck_red',
  3: 'dark_blue',
  4: 'purple',
  5: 'explosive',
  6: 'grass_green',
  7: 'bright_blue',
  8: 'saladish',
  9: 'egg_yolk',
  10: 'blackish',
  11: 'dark_red',
  12: 'sofia_pink',
  13: 'lipstick',
  14: 'dark_purple',
  15: 'bright_green',
  16: 'chili_blue',
  17: 'american_gray',
  18: 'brown',
  19: 'dark_orange',
  101: 'sunset',
  102: 'bubble',
  103: 'peach',
  104: 'berry',
  105: 'winter',
  106: 'river',
  107: 'navy',
  108: 'aquamarine',
  109: 'indigo',
  110: 'dark_indigo',
  151: 'pecan',
  152: 'lavender',
  153: 'royal',
  154: 'steel',
  155: 'orchid',
  156: 'lilac',
  157: 'tan',
  158: 'sky',
  159: 'coffee',
  160: 'teal',
};

/** Monday's grens per statuskolom; elke kleur mag er ook maar één keer in. */
export const MAX_LABELS = 40;

/** Eén label zoals de kolom het teruggeeft (`columns { settings }`). */
export interface StatusOptie {
  readonly id: number;
  readonly label: string;
  readonly color: number;
  /** De plek in de keuzelijst; Monday geeft hem niet voor elk label. */
  readonly index: number | null;
  readonly isDone: boolean;
  readonly isDeactivated: boolean;
  readonly hex: string | null;
  readonly description: string | null;
}

/** Eén label zoals `update_status_column` het wil. */
export interface StatusLabelInvoer {
  readonly id?: number;
  readonly label: string;
  readonly color: string;
  readonly index: number;
  readonly is_done: boolean;
  readonly is_deactivated: boolean;
  readonly description?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * De labels van een statuskolom, of een fout. Streng: een veld dat anders is dan verwacht
 * betekent dat Monday iets veranderd heeft, en dan schrijven we die lijst niet terug.
 */
export function leesStatusOpties(settings: unknown, waar: string): readonly StatusOptie[] {
  const labels = isRecord(settings) ? settings.labels : undefined;
  if (!Array.isArray(labels)) {
    throw new Error(`${waar}: de kolominstellingen hebben geen lijst labels.`);
  }
  return labels.map((raw, i): StatusOptie => {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'number' ||
      typeof raw.label !== 'string' ||
      typeof raw.color !== 'number'
    ) {
      throw new Error(`${waar}: label ${i} heeft geen id, tekst of kleur.`);
    }
    return {
      id: raw.id,
      label: raw.label,
      color: raw.color,
      index: typeof raw.index === 'number' ? raw.index : null,
      isDone: raw.is_done === true,
      isDeactivated: raw.is_deactivated === true,
      hex: typeof raw.hex === 'string' ? raw.hex : null,
      description: typeof raw.description === 'string' ? raw.description : null,
    };
  });
}

export type KeuzePlan =
  | { readonly kind: 'compleet' }
  | {
      readonly kind: 'toevoegen';
      readonly namen: readonly string[];
      /** De hele lijst: de bestaande labels ongewijzigd, de nieuwe achteraan. */
      readonly labels: readonly StatusLabelInvoer[];
    }
  /** Geen plaats of geen vrije kleur meer; dan schrijven we niets. */
  | { readonly kind: 'vol'; readonly namen: readonly string[] };

/**
 * Welke van de gewenste labels er nog niet in staan, als sleutel (`resolveLabelCode`).
 *
 * Via de schrijfwijzen: `Feedbacktrainer` op de Opportunity IS het label `FT`, dus daar komt geen
 * tweede `FT` naast. Een uitgeschakeld label telt ook als aanwezig: dat heeft iemand bewust
 * uitgezet, en het opnieuw toevoegen zou het onder een ander id terugzetten.
 */
export function ontbrekend(
  bestaand: readonly StatusOptie[],
  gewenst: readonly string[]
): readonly string[] {
  const aanwezig = new Set(
    bestaand.map((o) => resolveLabelCode(o.label)).filter((c): c is string => c !== null)
  );
  const uit: string[] = [];
  for (const naam of gewenst) {
    const sleutel = resolveLabelCode(naam);
    if (sleutel !== null && !aanwezig.has(sleutel)) {
      aanwezig.add(sleutel);
      uit.push(naam.trim());
    }
  }
  return uit;
}

/** Op hun plek in de keuzelijst; een label zonder plek komt achter de rest, op id. */
function opVolgorde(bestaand: readonly StatusOptie[]): readonly StatusOptie[] {
  return [...bestaand].sort(
    (a, b) =>
      (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || a.id - b.id
  );
}

/**
 * De bestaande labels zoals `update_status_column` ze terug wil: ongewijzigd, op hun plek.
 *
 * Weigert een kleur die we niet kennen: de hele lijst terugschrijven met een geraden kleur zou dat
 * label omkleuren.
 */
export function alsInvoer(
  bestaand: readonly StatusOptie[],
  waar: string
): readonly StatusLabelInvoer[] {
  return opVolgorde(bestaand).map((o, plek) => {
    const color = STATUS_KLEUR[o.color];
    if (color === undefined) {
      throw new Error(
        `${waar}: label "${o.label}" heeft kleur ${o.color}, die wij niet kennen. De hele lijst ` +
          'terugschrijven zou die kleur kunnen veranderen, dus er wordt niets geschreven.'
      );
    }
    return {
      id: o.id,
      label: o.label,
      color,
      index: plek,
      is_done: o.isDone,
      is_deactivated: o.isDeactivated,
      ...(o.description === null ? {} : { description: o.description }),
    };
  });
}

export function planKeuzelijst(
  bestaand: readonly StatusOptie[],
  gewenst: readonly string[],
  waar: string
): KeuzePlan {
  const namen = ontbrekend(bestaand, gewenst);
  if (namen.length === 0) {
    return { kind: 'compleet' };
  }
  const gebruikt = new Set(bestaand.map((o) => o.color));
  const vrij = Object.keys(STATUS_KLEUR)
    .map(Number)
    .filter((kleur) => !gebruikt.has(kleur));
  if (bestaand.length + namen.length > MAX_LABELS || vrij.length < namen.length) {
    return { kind: 'vol', namen };
  }

  const labels = [...alsInvoer(bestaand, waar)];
  namen.forEach((naam, i) => {
    labels.push({
      label: naam,
      color: STATUS_KLEUR[vrij[i]],
      index: bestaand.length + i,
      is_done: false,
      is_deactivated: false,
    });
  });
  return { kind: 'toevoegen', namen, labels };
}

/**
 * Wat er na het schrijven anders is dan het hoort, als lijst regels; leeg als alles klopt.
 *
 * Elk bestaand label moet er nog staan met hetzelfde id, dezelfde tekst, dezelfde kleur (nummer
 * én zichtbare hex) en dezelfde vinkjes. De plek in de lijst telt niet: die zetten wij opnieuw.
 */
export function controleerNa(
  voor: readonly StatusOptie[],
  na: readonly StatusOptie[],
  namen: readonly string[]
): readonly string[] {
  const problemen: string[] = [];
  const perId = new Map(na.map((o) => [o.id, o]));
  for (const oud of voor) {
    const nieuw = perId.get(oud.id);
    if (nieuw === undefined) {
      problemen.push(`label ${oud.id} "${oud.label}" is verdwenen`);
      continue;
    }
    const verschillen = [
      nieuw.label !== oud.label ? `tekst "${oud.label}" → "${nieuw.label}"` : null,
      nieuw.color !== oud.color ? `kleur ${oud.color} → ${nieuw.color}` : null,
      oud.hex !== null && nieuw.hex !== oud.hex ? `hex ${oud.hex} → ${nieuw.hex}` : null,
      nieuw.isDone !== oud.isDone ? 'is_done veranderd' : null,
      nieuw.isDeactivated !== oud.isDeactivated ? 'is_deactivated veranderd' : null,
    ].filter((v): v is string => v !== null);
    if (verschillen.length > 0) {
      problemen.push(`label ${oud.id} "${oud.label}": ${verschillen.join(', ')}`);
    }
  }
  const nu = new Set(na.map((o) => resolveLabelCode(o.label)));
  for (const naam of namen) {
    if (!nu.has(resolveLabelCode(naam))) {
      problemen.push(`het nieuwe label "${naam}" staat er niet in`);
    }
  }
  if (na.length !== voor.length + namen.length) {
    problemen.push(`${na.length} labels, verwacht ${voor.length + namen.length}`);
  }
  return problemen;
}
