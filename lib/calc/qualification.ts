import type { Qualification } from './types';

/**
 * Qualification precedence, best → worst. When malformed source data lists the
 * same trainer×theme under multiple colors, the best (earliest here) wins.
 * Legacy behavior: groen > oranje > rood > grijs.
 */
const PRECEDENCE: readonly Qualification[] = ['groen', 'oranje', 'rood', 'grijs'];

/**
 * Pick the highest-precedence qualification from a set of candidates.
 * Returns null when none are given.
 */
export function resolveQualification(candidates: readonly Qualification[]): Qualification | null {
  for (const q of PRECEDENCE) {
    if (candidates.includes(q)) {
      return q;
    }
  }
  return null;
}

/**
 * The colours that express an actual assessment, deduped. `grijs` is the
 * NOT-ASSESSED bucket, not a competing opinion — ITG's 30-July groen/rood
 * migration deliberately left trainers listed in grijs *alongside* their new
 * colour (`docs/build/03-aanbevelingsengine.md`), so treating grijs as a rival
 * assessment turns ~380 trainer×theme pairs into conflicts, leaves their
 * effective qualification null, and silently drops those trainers from every
 * recommendation.
 *
 * Use this before deciding whether a pair genuinely contradicts itself. A real
 * contradiction (groen AND rood) still survives and must be resolved explicitly.
 */
export function assessedColours(colours: readonly Qualification[]): Qualification[] {
  return [...new Set(colours)].filter((c) => c !== 'grijs');
}
