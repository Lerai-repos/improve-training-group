import { LABEL_CODES, isLabelCode } from './catalog';

import type { LabelCode, LabelConfig } from './types';

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
 * Bewust kort: website en inventarisatieformulier staan er niet in, want die voeden de
 * briefing. Een ontbrekende website mag geen rapport tegenhouden, en andersom.
 */
const REPORT_REQUIRED: ReadonlyArray<readonly ['volledigeNaam' | 'kleur' | 'rapportterm', string]> = [
  ['volledigeNaam', 'Volledige naam'],
  ['kleur', 'Kleur'],
  ['rapportterm', 'Rapportterm'],
];

/**
 * Wat er gekeurd wordt: een rij zoals hij van het BORD komt, met `code` als gewone string.
 *
 * Niet `LabelConfig`, want daarin is `code` al een `LabelCode` — en dan is de tak
 * `unknown_label` per definitie onbereikbaar zonder de compiler voor te liegen. Precies dát
 * gat maakte een cast in de test nodig, en een cast om een tak te bereiken betekent dat de
 * tak in productie niet bereikt kán worden. De boordwaarde is een string; dat hoort dit type
 * te zeggen.
 */
export type UncheckedLabelRow = Omit<LabelConfig, 'code'> & { readonly code: string };

export type CatalogProblem =
  | { kind: 'missing_label'; code: LabelCode }
  | { kind: 'unknown_label'; code: string }
  | { kind: 'duplicate_label'; code: string }
  | { kind: 'bad_colour'; code: string; found: string }
  | { kind: 'empty_field'; code: string; field: string };

/**
 * Keurt de hele verzameling, niet één rij.
 *
 * Ontbrekende en dubbele labels zijn per definitie eigenschappen van het geheel: een rij die
 * er niet is kan zichzelf niet melden, en een duplicaat is pas te zien naast zijn tweelingbroer.
 * Vandaar dat dit de complete lijst binnenkrijgt en een lijst problemen teruggeeft in plaats
 * van bij de eerste te stoppen — wie het bord repareert wil alles in één keer zien.
 */
export function validateCatalog(rows: readonly UncheckedLabelRow[]): readonly CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.code)) {
      problems.push({ kind: 'duplicate_label', code: row.code });
      continue;
    }
    seen.add(row.code);

    if (!isLabelCode(row.code)) {
      problems.push({ kind: 'unknown_label', code: row.code });
      continue;
    }

    for (const [field, title] of REPORT_REQUIRED) {
      if (row[field].trim() === '') {
        problems.push({ kind: 'empty_field', code: row.code, field: title });
      }
    }

    if (row.kleur.trim() !== '' && normaliseHex(row.kleur) === null) {
      problems.push({ kind: 'bad_colour', code: row.code, found: row.kleur });
    }
  }

  for (const code of LABEL_CODES) {
    if (!seen.has(code)) {
      problems.push({ kind: 'missing_label', code });
    }
  }

  return problems;
}

/** Eén probleem als Nederlandse regel, voor een foutmelding of een scriptuitvoer. */
export function describeProblem(problem: CatalogProblem): string {
  switch (problem.kind) {
    case 'missing_label':
      return `${problem.code}: geen rij op het Labels-bord`;
    case 'unknown_label':
      return `${problem.code}: onbekend label — de negen labels staan in LABEL_CODES`;
    case 'duplicate_label':
      return `${problem.code}: staat meerdere keren op het bord`;
    case 'bad_colour':
      return `${problem.code}: "${problem.found}" is geen hexkleur (verwacht #RRGGBB)`;
    case 'empty_field':
      return `${problem.code}: ${problem.field} is leeg`;
  }
}
