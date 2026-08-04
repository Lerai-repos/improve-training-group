export type StatusLabel = 'GEREED' | 'GEEN MATCH' | 'FOUT';

/** The scoped Monday writer — the ONLY thing in this system that writes to Monday. */
export interface StatusWriter {
  writeStatus(itemId: string, label: StatusLabel): Promise<void>;
}

export function isStatusLabel(v: string | null): v is StatusLabel {
  return v === 'GEREED' || v === 'GEEN MATCH' || v === 'FOUT';
}

/**
 * A writer that records instead of calling Monday — for dry runs and tests.
 *
 * NOTE: `deliverRun` used to live here and carried the delivery lease + fencing that
 * stopped a slow write landing after a newer one. That was Postgres advisory locks
 * plus generation CAS, and it is deliberately NOT reimplemented in this pass: it
 * needs an atomic compare-and-swap, which arrives with the KV `RunQueue`. Until
 * then nothing writes status automatically.
 */
export function createRecordingStatusWriter(): StatusWriter & {
  writes: Array<{ itemId: string; label: StatusLabel }>;
} {
  const writes: Array<{ itemId: string; label: StatusLabel }> = [];
  return {
    writes,
    writeStatus(itemId: string, label: StatusLabel): Promise<void> {
      writes.push({ itemId, label });
      return Promise.resolve();
    },
  };
}
