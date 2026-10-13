import { labelSleutel } from './catalog';

import type { LabelConfig } from './types';

/**
 * Alles wat er mis kan zijn met de labelconfiguratie, op één plek en zonder Monday.
 *
 * Het bord is voor iedereen bewerkbaar. Deze controles bestaan zodat een bewerking een
 * zichtbare fout wordt in plaats van een rapport in de verkeerde huisstijl — dat laatste
 * ziet er namelijk volkomen normaal uit voor wie het merk niet kent.
 */

/** Zes hex-cijfers met hekje. Monday's kolom is vrije tekst, dus dit is de enige bewaking. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * De kleur in canonieke vorm, of `null` als het geen kleur is.
 *
 * Kleine letters worden opgehoogd zodat `#265e5d` en `#265E5D` dezelfde waarde zijn — ze staan
 * allebei in ITG's eigen configuratie, en anders zou een vergelijking ze uit elkaar houden.
 */
export function normaliseHex(value: string): string | null {
  const trimmed = value.trim();
  return HEX.test(trimmed) ? `#${trimmed.slice(1).toUpperCase()}` : null;
}

/**
 * Wat het RAPPORT niet kan missen.
 *
 * Bewust kort: de website staat er niet in, want die voedt de inventarisatielink. Een
 * ontbrekende website mag geen rapport tegenhouden, en andersom.
 */
const REPORT_REQUIRED: ReadonlyArray<readonly ['volledigeNaam' | 'kleur' | 'rapportterm', string]> =
  [
    ['volledigeNaam', 'Volledige naam'],
    ['kleur', 'Kleur'],
    ['rapportterm', 'Rapportterm'],
  ];

/** Een rij zoals hij van het bord komt. Sinds elke rij een label is, gewoon `LabelConfig`. */
export type UncheckedLabelRow = LabelConfig;

export type CatalogProblem =
  | { kind: 'duplicate_label'; code: string }
  | { kind: 'bad_colour'; code: string; found: string }
  | { kind: 'empty_field'; code: string; field: string };

/**
 * Keurt de hele verzameling, niet één rij.
 *
 * Een dubbel label is een eigenschap van het geheel: een duplicaat is pas te zien naast zijn
 * tweelingbroer. Vandaar dat dit de complete lijst binnenkrijgt en een lijst problemen
 * teruggeeft in plaats van bij de eerste te stoppen — wie het bord repareert wil alles in één
 * keer zien.
 *
 * Een ontbrekend label meldt dit niet meer: welke labels er zijn beslist het bord. Een label dat
 * op de agenda staat zonder rij meldt de dagelijkse controle (`labelFindings`).
 */
export function validateCatalog(rows: readonly UncheckedLabelRow[]): readonly CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    /** Op de sleutel: `itg` en `ITG` zijn op de agenda hetzelfde label, dus ook hier. */
    const sleutel = labelSleutel(row.code);
    if (seen.has(sleutel)) {
      problems.push({ kind: 'duplicate_label', code: row.code });
      continue;
    }
    seen.add(sleutel);

    for (const [field, title] of REPORT_REQUIRED) {
      if (row[field].trim() === '') {
        problems.push({ kind: 'empty_field', code: row.code, field: title });
      }
    }

    if (row.kleur.trim() !== '' && normaliseHex(row.kleur) === null) {
      problems.push({ kind: 'bad_colour', code: row.code, found: row.kleur });
    }
  }

  return problems;
}

/** Eén probleem als Nederlandse regel, voor een foutmelding of een scriptuitvoer. */
export function describeProblem(problem: CatalogProblem): string {
  switch (problem.kind) {
    case 'duplicate_label':
      return `${problem.code}: staat meerdere keren op het bord`;
    case 'bad_colour':
      return `${problem.code}: "${problem.found}" is geen hexkleur (verwacht #RRGGBB)`;
    case 'empty_field':
      return `${problem.code}: ${problem.field} is leeg`;
  }
}
