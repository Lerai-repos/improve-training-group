/**
 * Pure, fail-closed guards for a Monday read pull (Stage-1/2 completeness +
 * coherence proofs). These are deliberately I/O-free so they can be unit-tested
 * and reused by both the snapshot extractor and the Slice-B GraphQL client.
 *
 * A stable `items_count` does NOT prove a coherent pull — an item can be edited
 * mid-pagination, or one removed while another is added (same count). So the
 * completeness check pairs a count assertion with a before/after `updated_at`
 * inventory comparison, and every violation throws.
 */

/** id → updated_at, captured before and after a full pagination pass. */
export type Inventory = Map<string, string>;

export interface InventoryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Assert the server honored the requested API version. Monday can silently fall
 * back to another supported version; if the response's reported version differs
 * from what we pinned, decoding assumptions may be wrong — fail the run.
 */
export function assertApiVersion(reported: string | null, requested: string): void {
  if (reported !== requested) {
    throw new Error(
      `Monday API-Version mismatch: requested ${requested}, server reported ${reported ?? 'none'}`
    );
  }
}

/** Ids that appear more than once across pages (cursor bug / overlap). */
export function findDuplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      dupes.add(id);
    }
    seen.add(id);
  }
  return [...dupes];
}

export function assertNoDuplicateIds(ids: readonly string[], label: string): void {
  const dupes = findDuplicateIds(ids);
  if (dupes.length > 0) {
    throw new Error(
      `${label}: duplicate item ids across pages (${dupes.length}): ${dupes.join(', ')}`
    );
  }
}

/**
 * Assert the fetched unique-id count equals the board's reported `items_count`.
 * A null `items_count` (unknown) is treated as unverifiable → fatal, because we
 * cannot prove completeness without it.
 */
export function assertCountMatches(
  uniqueFetched: number,
  itemsCount: number | null,
  label: string
): void {
  if (itemsCount === null) {
    throw new Error(`${label}: board reported no items_count — cannot prove completeness`);
  }
  if (uniqueFetched !== itemsCount) {
    throw new Error(
      `${label}: fetched ${uniqueFetched} unique items, items_count is ${itemsCount}`
    );
  }
}

/** Compare two id→updated_at inventories taken before and after a pull. */
export function diffInventory(before: Inventory, after: Inventory): InventoryDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [id, updatedAt] of after) {
    const prev = before.get(id);
    if (prev === undefined) {
      added.push(id);
    } else if (prev !== updatedAt) {
      changed.push(id);
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      removed.push(id);
    }
  }
  return { added, removed, changed };
}

/**
 * Fail if the board changed between the before/after inventories — an item was
 * added, removed, or its `updated_at` advanced during pagination, so the fetched
 * page set is not a coherent point-in-time snapshot.
 */
export function assertCoherent(before: Inventory, after: Inventory, label: string): void {
  const diff = diffInventory(before, after);
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total > 0) {
    throw new Error(
      `${label}: board changed during pagination — ` +
        `+${diff.added.length} / -${diff.removed.length} / ~${diff.changed.length} (not a coherent snapshot)`
    );
  }
}
