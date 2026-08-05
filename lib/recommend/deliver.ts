import { randomUUID } from 'node:crypto';

import { log } from '@lib/logger';

import type { StatusLabel, StatusWriter } from './delivery';
import type { QueueStore } from './queue-store';
import type { JobPublisher } from './queue';

/**
 * Getting one answer onto the board without an older one landing on top of a newer.
 *
 * The guarantee is **eventual convergence, not exclusion**, and the distinction is
 * deliberate. Monday offers no conditional write, so nothing here — and nothing in
 * the Postgres design that came before — can stop a stalled execution from writing
 * late. What it can do is notice: a monotonic per-training generation, checked
 * either side of the write, turns a stale write into a detectable event, and the
 * repair job converges the board on the newest answer.
 *
 * The pre-write check is also a real saving the old design never had: it discovered
 * supersession only after computing.
 */

/** A repair chain moves to a strictly greater generation each hop, so it terminates. */
export const MAX_REPAIR_HOPS = 3;

export interface DeliverDeps {
  queue: Pick<QueueStore, 'readGeneration' | 'recordJob'>;
  writer: StatusWriter;
  publisher: JobPublisher;
  /** Injectable so the durable-repair path is testable without wall-clock coupling. */
  nowMs?: () => number;
  /**
   * One id per detected stale write. Injectable for tests; `randomUUID` otherwise.
   * Deliberately NOT derived from the generation — see where it is used.
   */
  newRepairId?: () => string;
}

export interface DeliverInput {
  mondayItemId: string;
  generation: number;
  /** The authoritative label from the outcome store — never re-decided here. */
  label: StatusLabel;
  /** Repair depth; 0 for a job that came straight from a trigger. */
  hop?: number;
}

export type DeliverResult =
  | { delivered: true; repairPublished: boolean }
  | { delivered: false; reason: 'superseded' };

export async function deliverOutcome(
  deps: DeliverDeps,
  input: DeliverInput
): Promise<DeliverResult> {
  const { mondayItemId, generation, label, hop = 0 } = input;

  const before = await deps.queue.readGeneration(mondayItemId);
  if (before > generation) {
    // A newer trigger already exists; its job owns the board. Writing now would put
    // a known-stale label up, and the newer job would have to undo it.
    log.debug('deliver: superseded before write', { mondayItemId, generation, current: before });
    return { delivered: false, reason: 'superseded' };
  }

  await deps.writer.writeStatus(mondayItemId, label, {
    idempotencyKey: `${mondayItemId}:${generation}`,
  });

  const after = await deps.queue.readGeneration(mondayItemId);
  if (after <= generation) {
    return { delivered: true, repairPublished: false };
  }

  // A newer generation appeared while we were writing, so what is on the board may
  // now be stale. Its own job is usually already queued behind us under the same
  // Flow-Control key; the repair covers the case where that job ran first.
  if (hop >= MAX_REPAIR_HOPS) {
    log.warn('deliver: repair hop cap reached, leaving convergence to the newer job', {
      mondayItemId,
      generation,
      current: after,
    });
    return { delivered: true, repairPublished: false };
  }

  // A repair has no Monday trigger of its own, so it needs a synthetic id — and that id
  // must identify THIS stale write, not the generation it targets.
  //
  // Keyed on the target alone, two concurrent executions of one generation that each
  // land a stale write would produce the same id, and the second repair would be
  // deduplicated away: dropped by the publisher, or refused by `recordJob` because the
  // first record is still there. The board would stay wrong with nothing left to fix
  // it. Duplicate repairs, by contrast, are harmless — they deliver the same recorded
  // label under the same Monday idempotency key.
  const repairId = `repair:${mondayItemId}:${after}:${(deps.newRepairId ?? randomUUID)()}`;

  try {
    await deps.publisher.publish({
      triggerUuid: repairId,
      mondayItemId,
      generation: after,
      hop: hop + 1,
    });
  } catch (error) {
    // The Monday write ALREADY LANDED, so throwing would turn a successful delivery
    // into a retry that rewrites the board and eventually dead-letters a job that did
    // its work. But dropping the repair is not safe either: in the very case it exists
    // for — the newer generation FINISHED while our write was stalled, so our stale
    // label is now on top of the correct one — that newer job is already gone, and
    // nothing else would ever correct the board.
    //
    // So record it durably instead. The sweep publishes pending records, and this is
    // one, targeting the generation that already exists rather than allocating a new
    // one. If Redis is unreachable too this throws, and a retry is then the honest
    // answer.
    await deps.queue.recordJob({
      triggerUuid: repairId,
      mondayItemId,
      generation: after,
      // Same depth the direct publish would have carried, so recovery by the sweep
      // continues the chain rather than restarting it.
      hop: hop + 1,
      // Due immediately: the board is showing a stale label right now.
      nowMs: (deps.nowMs ?? Date.now)(),
    });
    log.warn('deliver: repair publish failed, handed to the sweep', {
      mondayItemId,
      generation,
      current: after,
      error: error instanceof Error ? error.message : String(error),
    });
    return { delivered: true, repairPublished: false };
  }

  return { delivered: true, repairPublished: true };
}
