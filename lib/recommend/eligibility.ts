import type { Qualification } from '@lib/calc';
import type { Acknowledgements } from '@lib/monday';
import { deriveEffective } from '@lib/sync/artifact';

import type { CandidateTrainer, EffectiveQual, QualObservation } from './types';

/**
 * Pure eligibility. Effective qualification is COMPUTED from the live colour
 * observations (all four colours) using the SAME logic as the M2a apply — a pair
 * seen in multiple colours is a conflict left NULL unless an acknowledged
 * resolution matches the exact observed colour set. A trainer qualifies only when
 * they are effective-green for EVERY theme on the training (zero themes → none).
 */

function pairKey(trainerExt: string, themaExt: string): string {
  return `${trainerExt}::${themaExt}`;
}

function sortedColourKey(colours: readonly Qualification[]): string {
  return [...new Set(colours)].sort().join(',');
}

/**
 * Resolve the effective qualification per (trainer, theme) from live observations.
 * Mirrors `lib/monday/validate.ts`: `deriveEffective` handles the unambiguous cases;
 * a conflict is resolved only when `ack.qualConflicts[key]` exactly matches the
 * observed colour set (a stale acknowledgement can't be reused).
 */
export function computeEffectiveQuals(
  observations: readonly QualObservation[],
  ack: Acknowledgements
): EffectiveQual[] {
  const coloursByPair = new Map<
    string,
    { trainerExt: string; themaExt: string; colours: Qualification[] }
  >();
  for (const o of observations) {
    const key = pairKey(o.trainerExternalId, o.themaExternalId);
    const entry = coloursByPair.get(key) ?? {
      trainerExt: o.trainerExternalId,
      themaExt: o.themaExternalId,
      colours: [],
    };
    entry.colours.push(o.colour);
    coloursByPair.set(key, entry);
  }

  const result: EffectiveQual[] = [];
  for (const [key, { trainerExt, themaExt, colours }] of coloursByPair) {
    const derived = deriveEffective(colours);
    let effective = derived.effective;
    const conflicted = derived.conflict_resolution !== null;
    if (conflicted) {
      const resolved = ack.qualConflicts[key];
      if (resolved && sortedColourKey(resolved.colours) === sortedColourKey(colours)) {
        effective = resolved.effective;
      }
    }
    result.push({
      trainerExternalId: trainerExt,
      themaExternalId: themaExt,
      observed: [...new Set(colours)].sort(),
      effective,
      conflicted,
    });
  }
  return result;
}

/**
 * Trainers that are effective-green for EVERY live theme. Candidates are already
 * restricted to the recommendable cohort by the snapshot read. A training with no
 * themes yields NONE (no basis to qualify).
 */
export function filterEligible(
  themeExternalIds: readonly string[],
  candidates: readonly CandidateTrainer[],
  effectiveQuals: readonly EffectiveQual[]
): CandidateTrainer[] {
  if (themeExternalIds.length === 0) {
    return [];
  }
  const greenPairs = new Set<string>();
  for (const q of effectiveQuals) {
    if (q.effective === 'green') {
      greenPairs.add(pairKey(q.trainerExternalId, q.themaExternalId));
    }
  }
  return candidates.filter((c) =>
    themeExternalIds.every((themeExt) => greenPairs.has(pairKey(c.externalItemId, themeExt)))
  );
}
