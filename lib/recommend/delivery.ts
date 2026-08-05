export type StatusLabel = 'GEREED' | 'GEEN MATCH' | 'FOUT';

export interface StatusWriteOptions {
  /**
   * Deterministic per (training, generation). Monday suppresses a repeat of the same
   * mutation for 30 minutes, making an at-least-once redelivery harmless. It does
   * not order competing writes.
   */
  idempotencyKey?: string;
}

/** The scoped Monday writer — the ONLY thing in this system that writes to Monday. */
export interface StatusWriter {
  writeStatus(itemId: string, label: StatusLabel, opts?: StatusWriteOptions): Promise<void>;
}

export function isStatusLabel(v: string | null): v is StatusLabel {
  return v === 'GEREED' || v === 'GEEN MATCH' || v === 'FOUT';
}

/**
 * A writer that records instead of calling Monday — for dry runs and tests.
 *
 * NOTE: `deliverRun` used to live here and carried a delivery lease plus generation
 * fencing. Neither returns, and the reason is worth keeping: **fencing cannot work
 * against Monday.** A fencing token is only safe if the resource rejects a write
 * carrying a stale token, and Monday has no conditional write — no If-Match, no
 * ETag, no compare-and-set on a column. The Postgres version did not really close
 * this either: its advisory lock was released at commit, BEFORE the Monday HTTP
 * write, so a write slower than the 60s delivery lease could still be double-applied.
 *
 * What actually made it safe was detect-and-repair convergence, and that is what
 * `deliver.ts` reimplements: a monotonic per-training generation, a recheck either
 * side of the write, and a repair job when a newer generation appeared mid-write.
 */
export function createRecordingStatusWriter(): StatusWriter & {
  writes: Array<{ itemId: string; label: StatusLabel; idempotencyKey?: string }>;
} {
  const writes: Array<{ itemId: string; label: StatusLabel; idempotencyKey?: string }> = [];
  return {
    writes,
    writeStatus(itemId, label, opts): Promise<void> {
      writes.push({ itemId, label, idempotencyKey: opts?.idempotencyKey });
      return Promise.resolve();
    },
  };
}
