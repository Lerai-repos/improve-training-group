/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { normalizeAddressKey } from '@lib/recommend/travel-cache';
import { createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * STEP 0b: derive the COMMITTED `fixtures/replay/` from the gitignored
 * `snapshots/replay/` recording, with every trainer name, trainer address and
 * client location replaced by a synthetic stand-in.
 *
 * Addresses are not inert data here — they feed the HMAC fingerprints stored in
 * the audit artifact (`enrichment.routes[*].originFingerprint` /
 * `destinationFingerprint`) and the travel-cache keys. So the rewrite has to be
 * done on inputs AND expected outputs together, or the equivalence check fails on
 * behaviour that is in fact identical:
 *
 *   1. The mapping is deterministic — the same real address always yields the same
 *      synthetic one — so cache hits and route lookups replay identically.
 *   2. Expected fingerprints are RECOMPUTED from the synthetic address under a
 *      fixed test-only key, never copied across from the recording.
 *
 *   pnpm tsx scripts/sanitize-replay.ts
 */

const IN_DIR = join(process.cwd(), 'snapshots', 'replay');
const OUT_DIR = join(process.cwd(), 'fixtures', 'replay');

/**
 * Fixed key for fixtures, so fingerprints are reproducible on any machine and in
 * CI. Never a real secret — the fixture addresses it protects are synthetic.
 */
export const REPLAY_ADDRESS_HASH_KEY = 'replay-fixture-address-hash-key-v1';

/**
 * Mirrors `addressKey()` in lib/recommend/address-key.ts, but takes the key as an
 * argument — that module caches its key at first use, so one process cannot hash
 * under both the real and the test key. `sanitize-replay.test.ts` pins the two
 * implementations together so they cannot drift.
 */
export function fingerprint(key: string, address: string): string {
  return createHmac('sha256', key).update(normalizeAddressKey(address)).digest('hex').slice(0, 16);
}

/** A stable synthetic address; index-derived so the same input always maps the same. */
function syntheticAddress(i: number): string {
  const postcode = `${1000 + i} ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`;
  return `Teststraat ${i + 1}, ${postcode} Voorbeeldstad`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string value in the tree, for address/name discovery. */
function collectStrings(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      collectStrings(v, out);
    }
    return;
  }
  if (isRecord(node)) {
    for (const v of Object.values(node)) {
      collectStrings(v, out);
    }
  }
}

/**
 * Rewrite every string in the tree. Exact matches first, then substring — an
 * address can be embedded in free text (`unresolved_location.detail` is the LLM's
 * own words about the raw location, and can quote it verbatim).
 */
function rewrite(node: unknown, map: Map<string, string>): unknown {
  if (typeof node === 'string') {
    const exact = map.get(node);
    if (exact !== undefined) {
      return exact;
    }
    let s = node;
    for (const [from, to] of map) {
      if (from.length > 3 && s.includes(from)) {
        s = s.split(from).join(to);
      }
    }
    return s;
  }
  if (Array.isArray(node)) {
    return node.map((v) => rewrite(v, map));
  }
  if (isRecord(node)) {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v, map)]));
  }
  return node;
}

interface Shared {
  config?: { hqAddress?: string };
  inputs?: { trainers?: Array<{ naam?: string; adres?: string | null }> };
}

async function main(): Promise<void> {
  const realKey = process.env.ADDRESS_HASH_KEY;
  if (!realKey) {
    throw new Error(
      'ADDRESS_HASH_KEY must be set to the SAME value used when recording — the ' +
        'recorded fingerprints cannot be mapped back to their addresses otherwise.'
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(IN_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No recordings in ${IN_DIR} — run scripts/record-replay.ts first.`);
  }
  const docs = new Map<string, unknown>();
  for (const f of files) {
    docs.set(f, JSON.parse(readFileSync(join(IN_DIR, f), 'utf8')));
  }

  // 1. Discover the real addresses and names to replace.
  const shared: Shared = (docs.get('_shared.json') as Shared) ?? {};
  const addresses = new Set<string>();
  const names = new Set<string>();
  for (const t of shared.inputs?.trainers ?? []) {
    if (t.adres && t.adres.trim() !== '') {
      addresses.add(t.adres);
    }
    if (t.naam) {
      names.add(t.naam);
    }
  }
  if (shared.config?.hqAddress) {
    addresses.add(shared.config.hqAddress);
  }
  // Locations and formatted addresses live in the per-training recordings.
  for (const [name, doc] of docs) {
    if (name === '_shared.json') {
      continue;
    }
    const rec = isRecord(doc) ? doc.recorded : null;
    if (!isRecord(rec)) {
      continue;
    }
    const training = isRecord(rec.training) ? rec.training : null;
    if (training && typeof training.locatie === 'string' && training.locatie.trim() !== '') {
      addresses.add(training.locatie);
    }
    for (const call of Array.isArray(rec.addressCalls) ? rec.addressCalls : []) {
      if (!isRecord(call)) {
        continue;
      }
      if (typeof call.raw === 'string' && call.raw.trim() !== '') {
        addresses.add(call.raw);
      }
      const d = isRecord(call.decision) ? call.decision : null;
      if (d && typeof d.formatted === 'string') {
        addresses.add(d.formatted);
      }
    }
    for (const call of Array.isArray(rec.travelCalls) ? rec.travelCalls : []) {
      if (!isRecord(call)) {
        continue;
      }
      for (const o of Array.isArray(call.origins) ? call.origins : []) {
        if (typeof o === 'string' && o.trim() !== '') {
          addresses.add(o);
        }
      }
      if (typeof call.destination === 'string') {
        addresses.add(call.destination);
      }
    }
  }

  // 2. Build the deterministic maps. Longest-first so a longer address is replaced
  //    before a shorter one that is a prefix of it.
  const sortedAddresses = [...addresses].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const sortedNames = [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const map = new Map<string, string>();
  sortedAddresses.forEach((real, i) => map.set(real, syntheticAddress(i)));
  sortedNames.forEach((real, i) => map.set(real, `Trainer ${String(i + 1).padStart(3, '0')}`));

  // 3. Fingerprints: real (recorded) → recomputed from the SYNTHETIC address under
  //    the fixed test key. Never copied across.
  for (const real of sortedAddresses) {
    const synthetic = map.get(real);
    if (synthetic === undefined) {
      continue;
    }
    map.set(fingerprint(realKey, real), fingerprint(REPLAY_ADDRESS_HASH_KEY, synthetic));
  }

  // 4. Rewrite and write out.
  for (const [name, doc] of docs) {
    writeFileSync(join(OUT_DIR, name), `${JSON.stringify(rewrite(doc, map), null, 2)}\n`);
  }
  writeFileSync(
    join(OUT_DIR, '_meta.json'),
    `${JSON.stringify(
      {
        note: 'Generated by scripts/sanitize-replay.ts from the gitignored snapshots/replay/. All names and addresses are synthetic; fingerprints are recomputed under addressHashKey below.',
        addressHashKey: REPLAY_ADDRESS_HASH_KEY,
        addressesReplaced: sortedAddresses.length,
        namesReplaced: sortedNames.length,
      },
      null,
      2
    )}\n`
  );

  // 5. Refuse to ship a fixture that still contains a real address or name.
  const leaked: string[] = [];
  for (const name of docs.keys()) {
    const text = readFileSync(join(OUT_DIR, name), 'utf8');
    const strings = new Set<string>();
    collectStrings(JSON.parse(text), strings);
    for (const real of [...sortedAddresses, ...sortedNames]) {
      if (text.includes(real)) {
        leaked.push(`${name}: ${real}`);
      }
    }
    void strings;
  }
  if (leaked.length > 0) {
    throw new Error(`Sanitization INCOMPLETE — real data survived:\n  ${leaked.join('\n  ')}`);
  }

  console.log(
    `Sanitized ${docs.size} files → fixtures/replay/ ` +
      `(${sortedAddresses.length} addresses, ${sortedNames.length} names replaced)`
  );
}

main().catch((error) => {
  console.error('sanitize-replay failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
