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
