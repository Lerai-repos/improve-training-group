import { assessedColours, type Qualification } from '@lib/calc';

/**
 * Deriving one effective green/red verdict for a trainer×theme pair from the raw
 * colours observed on the Thema's board.
 *
 * The rules are deliberately conservative. Only unambiguous groen→green and rood→red
 * auto-map; oranje leaves effective null (since ITG's 30-July migration it is
 * residual data, never a qualification); and two genuinely different colours leave
 * effective null while recording them for the reviewed allowlist in
 * `docs/m2a/acknowledgements.json` to resolve.
 *
 * `grijs` is NOT ASSESSED, not a rival opinion. Treating it as one produced 382 false
 * conflicts after the migration and silently excluded three trainers from ~95 themes
 * each — see `assessedColours`.
 *
 * This file previously also held `buildArtifact`, which shaped decoded boards for the
 * Postgres apply RPC. That RPC and its snapshot are gone, so the builder went with
 * them; only the qualification rules were ever used by the live engine.
 */

export type EffectiveQualification = 'green' | 'red';

export function deriveEffective(colours: readonly Qualification[]): {
  effective: EffectiveQualification | null;
  conflict_resolution: { colours: Qualification[] } | null;
} {
  const unique = assessedColours(colours);
  if (unique.length > 1) {
    return { effective: null, conflict_resolution: { colours: unique } };
  }
  const only = unique[0];
  if (only === 'groen') {
    return { effective: 'green', conflict_resolution: null };
  }
  if (only === 'rood') {
    return { effective: 'red', conflict_resolution: null };
  }
  return { effective: null, conflict_resolution: null };
}
