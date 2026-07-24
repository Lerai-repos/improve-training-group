/**
 * Klant (client) identity derivation from the `Bedrijf` mirror.
 *
 * The live board proved the item name is dirty (`KNGF Geleidehonden (copy)`,
 * `Capri - 2026 Q2`), so klant keys off the Bedrijf mirror. Two separate
 * functions, on purpose:
 *
 * - {@link klantIdentityKey} — the STORED key. Minimal normalization only (trim,
 *   collapse whitespace, Unicode NFC). It deliberately does NOT strip `(copy)` or
 *   fold case, because those are *merge* decisions a human must confirm.
 * - {@link klantFingerprint} — a diagnostic-only, more aggressive fold (lowercase
 *   + strip trailing `(copy)`). Used solely to SURFACE alias candidates; two
 *   distinct identity keys sharing a fingerprint are flagged for an explicit
 *   merge/separate decision, never merged automatically.
 */

const WHITESPACE = /\s+/g;
const TRAILING_COPY = /(?:\s*\(copy\))+\s*$/gi;

/** The stored klant key — conservative, never auto-merges. `''` if empty. */
export function klantIdentityKey(name: string | null | undefined): string {
  if (!name) {
    return '';
  }
  return name.normalize('NFC').replace(WHITESPACE, ' ').trim();
}

/** Aggressive fold used ONLY to detect alias candidates. `''` if empty. */
export function klantFingerprint(name: string | null | undefined): string {
  if (!name) {
    return '';
  }
  return name
    .normalize('NFC')
    .replace(TRAILING_COPY, '')
    .replace(WHITESPACE, ' ')
    .trim()
    .toLowerCase();
}

export interface AliasCandidate {
  fingerprint: string;
  keys: string[];
}

/**
 * Group distinct identity keys by fingerprint. Any fingerprint covering more
 * than one distinct identity key is an alias candidate (e.g. `De Heus` /
 * `De Heus (copy)`, `Repair Care` / `Repair care`) — fatal until a human decides
 * merge-or-separate.
 */
export function findAliasCandidates(
  names: readonly (string | null | undefined)[]
): AliasCandidate[] {
  const byFingerprint = new Map<string, Set<string>>();
  for (const name of names) {
    const key = klantIdentityKey(name);
    if (!key) {
      continue;
    }
    const fp = klantFingerprint(name);
    const set = byFingerprint.get(fp) ?? new Set<string>();
    set.add(key);
    byFingerprint.set(fp, set);
  }

  const candidates: AliasCandidate[] = [];
  for (const [fingerprint, keys] of byFingerprint) {
    if (keys.size > 1) {
      candidates.push({ fingerprint, keys: [...keys].sort() });
    }
  }
  return candidates.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
