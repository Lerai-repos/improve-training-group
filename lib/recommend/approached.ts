import type { KvStore, TtlState } from './kv';
import { ROWS_TTL_MS } from './outcome';

/**
 * Which trainers a planner has already contacted about a training.
 *
 * Scoped to a **generation**, not just a training. A recalculate produces a new ranked
 * list against fresh Monday data, and carrying the ticks across would assert something
 * nobody did: that the planner approached a trainer *on the new list*, which might not
 * even contain them. Each list keeps its own marks.
 *
 * ## One key per trainer, not one set per list
 *
 * Two planners can tick two different trainers at the same moment. A single JSON blob
 * would make that a read-modify-write race and one tick would vanish; separate keys make
 * concurrent ticks independent by construction, and the read cost stays one round trip
 * via `mget`.
 *
 * ## The lifetime is borrowed, never fresh
 *
 * A mark annotates a specific stored list, so it is written with whatever is LEFT of
 * that list's TTL. Writing a fresh twelve months would let a mark ticked in month eleven
 * outlive its rows by nearly a year — and since the key is generation-scoped, it would
 * sit there unreadable rather than harmlessly.
 */

const approachedKey = (mondayItemId: string, generation: number, trainerItemId: string): string =>
  `approached:${mondayItemId}:${generation}:${trainerItemId}`;

const APPROACHED = '1';

export interface ApproachedStore {
  /** The subset of `trainerItemIds` that are marked. One round trip. */
  read(
    mondayItemId: string,
    generation: number,
    trainerItemIds: readonly string[]
  ): Promise<Set<string>>;
  /**
   * Tick or untick one trainer. `rowsTtl` is the remaining lifetime of the list this
   * mark belongs to; a mark against rows that are already gone is refused, because
   * there is no list for it to annotate.
   */
  write(input: {
    mondayItemId: string;
    generation: number;
    trainerItemId: string;
    approached: boolean;
    rowsTtl: TtlState;
  }): Promise<boolean>;
}

export function createApproachedStore(kv: KvStore): ApproachedStore {
  return {
    async read(mondayItemId, generation, trainerItemIds) {
      const values = await kv.mget(
        trainerItemIds.map((trainerItemId) => approachedKey(mondayItemId, generation, trainerItemId))
      );

      const marked = new Set<string>();
      trainerItemIds.forEach((trainerItemId, index) => {
        if (values[index] === APPROACHED) {
          marked.add(trainerItemId);
        }
      });
      return marked;
    },

    async write({ mondayItemId, generation, trainerItemId, approached, rowsTtl }) {
      if (rowsTtl.kind === 'absent') {
        return false;
      }

      const key = approachedKey(mondayItemId, generation, trainerItemId);

      if (!approached) {
        // An absent key IS "not approached", so unticking deletes rather than storing a
        // tombstone that would need expiry rules of its own for no gain.
        await kv.del(key);
        return true;
      }

      // `no-expiry` cannot happen for a rows key — the claim always sets one — but
      // "borrow forever" is the single outcome worth not risking on an invariant, so it
      // falls back to the full rows lifetime instead of to none.
      const ttlMs = rowsTtl.kind === 'expires' ? rowsTtl.ms : ROWS_TTL_MS;
      await kv.set(key, APPROACHED, { ttlMs });
      return true;
    },
  };
}
