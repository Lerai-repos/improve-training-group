import { isStatusLabel, type StatusLabel } from './delivery';

import type { KvStore } from './kv';

/**
 * The immutable outcome of one (training, generation).
 *
 * Compute is not idempotent — it reads live Monday data and calls paid providers, so
 * running it twice for the same generation can legitimately produce two different
 * answers. Every redelivery path (a QStash retry, a repair hop, a DLQ replay, the
 * failure callback) therefore reads the recorded outcome instead of recomputing, and
 * the FIRST writer wins. Without this a retry could silently flip a delivered label.
 *
 * Records carry NO expiry. QStash's fixed-plan DLQ retention reaches three calendar
 * months and enterprise retention is custom, so any fixed TTL risks lapsing before a
 * replay — after which that replay would recompute a generation already answered.
 * One short string per (training, generation) is not worth the failure mode.
 */

const key = (mondayItemId: string, generation: number): string =>
  `result:${mondayItemId}:${generation}`;

export interface OutcomeStore {
  /**
   * Record this execution's label, or discover the one that got there first.
   * Returns the AUTHORITATIVE label — deliver that, never the caller's own.
   */
  claim(mondayItemId: string, generation: number, label: StatusLabel): Promise<StatusLabel>;
  read(mondayItemId: string, generation: number): Promise<StatusLabel | null>;
}

export function createOutcomeStore(kv: KvStore): OutcomeStore {
  const read = async (mondayItemId: string, generation: number): Promise<StatusLabel | null> => {
    const raw = await kv.get(key(mondayItemId, generation));
    // A value that isn't a terminal label is corruption, not an outcome. Treating it
    // as absent lets the caller recompute rather than write nonsense to the board.
    return isStatusLabel(raw) ? raw : null;
  };

  return {
    read,
    async claim(mondayItemId, generation, label) {
      const won = await kv.setIfAbsent(key(mondayItemId, generation), label);
      if (won) {
        return label;
      }
      // Lost the race. Re-read rather than assume: the winner's label is the one
      // already on its way to the board.
      return (await read(mondayItemId, generation)) ?? label;
    },
  };
}
