import { z } from 'zod';

import type { ApproachedStore } from './approached';
import type { ItemBoardReader } from './item-board';
import type { OutcomeStore } from './outcome';
import type { QueueStore } from './queue-store';
import type { RunQueue } from './webhook';

/**
 * The two things a planner can do to a recommendation list: ask for a new one, and note
 * that they have contacted someone.
 *
 * Both live here rather than in the route files so the rules are unit-testable without
 * an HTTP server, and so the two mutations cannot drift on the checks they share.
 */

export interface ActionResult {
  status: number;
  body: { success: true; data?: unknown } | { success: false; error: string };
}

const ok = (data?: unknown): ActionResult => ({ status: 200, body: { success: true, data } });
const fail = (status: number, error: string): ActionResult => ({
  status,
  body: { success: false, error },
});

/**
 * The client mints this and reuses it while retrying, so a flaky network cannot spend
 * two computations. It becomes the `triggerUuid` — a Redis key component — so the
 * charset is constrained rather than trusted: a value containing `:` could otherwise be
 * shaped to collide with a different record's key.
 */
const actionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'actionId must be 8-64 characters of [A-Za-z0-9_-]');

export const recalculateBodySchema = z.object({ actionId: actionIdSchema });

export const approachedBodySchema = z.object({
  generation: z.number().int().positive(),
  trainerItemId: z.string().regex(/^\d+$/, 'trainerItemId must be a Monday item id'),
  approached: z.boolean(),
});

/**
 * `GET` is account-wide and historical by design; mutations are not.
 *
 * A `view` holder may open any item that ever produced an artifact. Spending money on a
 * recomputation, or writing shared planning state, is confined to the Agenda board the
 * engine is configured for — otherwise any item id in the account would be a lever on
 * our provider budget.
 *
 * A non-existent item and an item on another board both answer 403. The distinction is
 * logged, not returned: an authenticated caller should not be handed an oracle for which
 * ids exist.
 */
async function onAgendaBoard(
  boards: ItemBoardReader,
  agendaBoardId: string,
  mondayItemId: string
): Promise<boolean> {
  return (await boards.readBoardId(mondayItemId)) === agendaBoardId;
}

export interface RecalculateDeps {
  queue: RunQueue;
  boards: ItemBoardReader;
  agendaBoardId: string;
}

export async function handleRecalculate(
  deps: RecalculateDeps,
  input: { mondayItemId: string; body: unknown }
): Promise<ActionResult> {
  const parsed = recalculateBodySchema.safeParse(input.body);
  if (!parsed.success) {
    return fail(400, parsed.error.issues[0]?.message ?? 'invalid body');
  }

  if (!(await onAgendaBoard(deps.boards, deps.agendaBoardId, input.mondayItemId))) {
    return fail(403, 'forbidden');
  }

  const result = await deps.queue.enqueue({
    triggerUuid: parsed.data.actionId,
    // The kind the queue already models for a human pressing a button, as opposed to a
    // group move. Nothing downstream branches on it today; it is provenance.
    triggerKind: 'manual_button',
    mondayItemId: input.mondayItemId,
  });

  // A duplicate is a SUCCESS, not a conflict: the same `actionId` arriving twice is the
  // retry working exactly as intended, and the button should settle rather than show an
  // error for work that is already queued.
  return result.accepted
    ? ok({ queued: true, generation: result.generation })
    : ok({ queued: false, reason: result.reason });
}

export interface ApproachedDeps {
  queue: Pick<QueueStore, 'readGeneration'>;
  outcomes: Pick<OutcomeStore, 'readDetail' | 'readRowsTtl'>;
  approached: ApproachedStore;
  boards: ItemBoardReader;
  agendaBoardId: string;
}

export async function handleApproached(
  deps: ApproachedDeps,
  input: { mondayItemId: string; body: unknown }
): Promise<ActionResult> {
  const parsed = approachedBodySchema.safeParse(input.body);
  if (!parsed.success) {
    return fail(400, parsed.error.issues[0]?.message ?? 'invalid body');
  }
  const { generation, trainerItemId, approached } = parsed.data;

  if (!(await onAgendaBoard(deps.boards, deps.agendaBoardId, input.mondayItemId))) {
    return fail(403, 'forbidden');
  }

  // The generation the client saw must still be current. Another planner may have
  // recalculated since the view loaded, and a tick against the old list would attach to
  // trainers nobody is looking at any more.
  const current = await deps.queue.readGeneration(input.mondayItemId);
  if (current !== generation) {
    return fail(409, `generation ${generation} is stale — the list is now generation ${current}`);
  }

  const detail = await deps.outcomes.readDetail(input.mondayItemId, generation);
  if (detail === null || detail.kind !== 'ready') {
    // No list to annotate: expired, legacy, no match, or a failure. Not the client's
    // mistake, so not a 4xx about their input — the list simply moved on.
    return fail(409, 'there is no ranked list for this generation');
  }

  // The trainer must be ON this list. Without it, any Monday item id could be marked,
  // and the mark would be invisible — it is only ever read back per listed trainer.
  if (!detail.rows.some((row) => row.trainerItemId === trainerItemId)) {
    return fail(422, 'that trainer is not on this recommendation list');
  }

  const written = await deps.approached.write({
    mondayItemId: input.mondayItemId,
    generation,
    trainerItemId,
    approached,
    rowsTtl: await deps.outcomes.readRowsTtl(input.mondayItemId, generation),
  });

  // The rows expired between the read above and this write. Rare, and reported honestly
  // rather than answered with a success that stored nothing.
  if (!written) {
    return fail(409, 'the list expired mid-update');
  }

  /**
   * Check the generation AGAIN, after writing.
   *
   * The check above and this write are not atomic, so a recalculate can land between
   * them. The mark is generation-scoped, so it lands on a list nobody will read again —
   * and answering 200 would be the worst outcome available: the planner sees the tick
   * accepted, the next `GET` reads the new generation's marks, and it is simply gone.
   * They would reasonably conclude the feature loses data.
   *
   * The orphaned key is left where it is rather than deleted. It expires with the rows
   * it belongs to, it is unreachable in the meantime, and deleting could race with
   * another planner legitimately writing the same key.
   */
  const afterWrite = await deps.queue.readGeneration(input.mondayItemId);
  if (afterWrite !== generation) {
    return fail(409, `the list moved to generation ${afterWrite} while the mark was being saved`);
  }

  return ok({ trainerItemId, approached });
}
