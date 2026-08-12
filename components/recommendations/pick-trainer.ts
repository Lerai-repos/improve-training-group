'use client';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { readLinkedTrainers } from './linked-trainers';

import type { RecommendationsApi } from './api';
import type { MondayBridge } from './monday-client';
import type { RecommendationView } from './types';

/**
 * Linking the chosen trainer to the training.
 *
 * **Written client-side, as the logged-in planner.** Our backend token never touches it,
 * so Monday's own column permissions are the real enforcement: a planner who cannot edit
 * the trainer relation by hand cannot make the app do it for them. `canPlan` decides
 * whether the button is *shown*; Monday decides whether the write *lands*. Both are
 * stated because neither is a substitute for the other.
 *
 * ## What "stale" can and cannot promise
 *
 * Another planner can recalculate at any moment, after which this list is superseded and
 * the trainer on it may no longer be eligible. Three checks, and an honest limit:
 *
 * 1. **Before** the write — re-read the generation and refuse if it moved.
 * 2. The write itself.
 * 3. **After** the write — read again, and if it moved *during*, say so.
 *
 * Step 3 detects; it does not repair. Monday offers no conditional relation mutation, so
 * no client-side check can be atomic with the write — and once the relation is set,
 * silently reversing a planner's write would be worse than the staleness. So the outcome
 * is a warning naming the trainer that was linked, and a human decides.
 *
 * ## Replace or append
 *
 * The relation write REPLACES the column's whole list, and **80 of the 756 trainings on
 * Agenda 2026 carry two or more trainers** — so a single "Kies" meant two incompatible
 * things: "I changed my mind" and "this training needs a second trainer", with the second
 * silently destroying the first choice. The mode is therefore an argument with no default:
 * the caller has to have asked.
 */

const LINK_TRAINER = `
mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
  change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
    id
  }
}`;

/**
 * Is this list still the one we are choosing from?
 *
 * A generation number alone is not enough. The same generation can come back
 * `unavailable` once the rows expire, and a `ready` list can be rebuilt without this
 * trainer on it — both would pass a numeric comparison while the thing we are about to
 * link is no longer something the engine stands behind.
 */
function usable(
  view: RecommendationView,
  generation: number,
  trainerItemId: string
): boolean {
  const { state } = view;
  return (
    state.kind === 'ready' &&
    state.generation === generation &&
    state.rows.some((row) => row.trainerItemId === trainerItemId)
  );
}

export type PickOutcome =
  | { kind: 'linked' }
  /** The list had already moved BEFORE anything was written. Nothing happened. */
  | { kind: 'refused'; generation: number }
  /** Written, then found to be stale. Needs a human — see the note above. */
  | { kind: 'linked_but_stale'; trainerItemId: string }
  /**
   * The write went out, but the trainer is NOT on the relation afterwards.
   *
   * An append is an unguarded read-modify-write and Monday has no conditional relation
   * mutation, so two planners who read `[A]` at the same time and append B and C write
   * `[A,B]` and `[A,C]` — and the later write erases the earlier addition.
   *
   * **BEST EFFORT, and knowingly incomplete.** This catches the interleaving where the
   * other write lands between ours and our check. It does NOT catch the one where both
   * writes are verified before either is replaced — client 1 writes and verifies, then
   * client 2 writes and verifies, and B is gone while both planners were told it worked.
   * Closing that needs serialization around the read-modify-write, which would mean moving
   * the relation write to our backend and losing the property that it happens as the
   * logged-in planner, with Monday's own column permissions as the real enforcement.
   * Accepted deliberately: the outcome is visible on the board and correctable by hand.
   */
  | { kind: 'linked_but_lost'; trainerItemId: string }
  /**
   * Written, but we could not confirm the list had not moved.
   *
   * Distinct from `failed`, and the distinction matters more than it looks: the relation
   * IS set. Reporting a post-write read failure as a failed pick would tell the planner
   * nothing happened when something did, and they would pick again — overwriting a
   * correct link, or linking a second trainer.
   */
  | { kind: 'linked_unverified'; trainerItemId: string; message: string }
  | { kind: 'failed'; message: string };

/** 0 for `idle`, so "never computed" reads as a moved list rather than as generation 1. */
function generationOf(view: RecommendationView): number {
  return view.state.kind === 'idle' ? 0 : view.state.generation;
}

export interface PickDeps {
  monday: MondayBridge;
  api: RecommendationsApi;
  boardId: string;
}

/**
 * What a pick does to the trainers already on the training.
 *
 * - `replace` — this trainer becomes the only one. Destructive, and the historical
 *   behaviour of every pick.
 * - `append` — added alongside whoever is already linked.
 */
export type PickMode = 'replace' | 'append';

/**
 * The ids to write, read FRESH from Monday when appending.
 *
 * Deliberately not taken from the caller: the view refreshes the relation every 20
 * seconds, so a union built from what the planner can see would drop a trainer a
 * colleague linked inside that window — the very bug `append` exists to prevent.
 */
async function idsToWrite(
  deps: PickDeps,
  mondayItemId: string,
  trainerItemId: string,
  mode: PickMode
): Promise<readonly string[]> {
  if (mode === 'replace') {
    return [trainerItemId];
  }
  const linked = await readLinkedTrainers(deps.monday, mondayItemId);
  return [...new Set([...linked, trainerItemId])];
}

export async function pickTrainer(
  deps: PickDeps,
  input: {
    mondayItemId: string;
    generation: number;
    trainerItemId: string;
    mode: PickMode;
  }
): Promise<PickOutcome> {
  const { mondayItemId, generation, trainerItemId, mode } = input;

  // 1. Refuse a list we already know is superseded — this is the cheap, complete check.
  //
  // A failure here is a plain failure: nothing has been written, so saying so is both
  // accurate and safe to retry.
  let before: RecommendationView;
  try {
    before = await deps.api.get(mondayItemId);
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (!usable(before, generation, trainerItemId)) {
    return { kind: 'refused', generation: generationOf(before) };
  }

  // 2. The write. A board relation takes its ids as a JSON-encoded string, not an array.
  //
  // The relation read for an append sits INSIDE this try on purpose: without the current
  // list there is no union to write, and falling back to the new trainer alone would
  // perform the destructive replace the planner explicitly declined. Nothing is written,
  // so the failure is plainly retryable.
  try {
    const ids = await idsToWrite(deps, mondayItemId, trainerItemId, mode);
    await deps.monday.api(LINK_TRAINER, {
      boardId: deps.boardId,
      itemId: mondayItemId,
      columnId: AGENDA_2026_COLUMNS.trainerRelation,
      value: JSON.stringify({ item_ids: ids.map(Number) }),
    });
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }

  // 3. Detect a recalculate that landed mid-write. Not repaired — surfaced.
  //
  // This read can fail on its own, and everything after the write must therefore be
  // reported as "written, unconfirmed" rather than allowed to escape as an error: from
  // the planner's side an exception here is indistinguishable from a failed pick, and
  // they would try again on a relation that is already set.
  try {
    /**
     * Did our own write survive?
     *
     * Checked BEFORE staleness, because it is the more serious answer: a stale list is a
     * warning about relevance, whereas a missing link means the planner believes they
     * scheduled a trainer who is not on the training. A concurrent append by a colleague
     * is the way this happens — see `linked_but_lost`.
     */
    const linkedAfter = await readLinkedTrainers(deps.monday, mondayItemId);
    if (!linkedAfter.includes(trainerItemId)) {
      return { kind: 'linked_but_lost', trainerItemId };
    }

    const after = await deps.api.get(mondayItemId);
    // Same test, not just the number: a list that has since expired, failed, or been
    // rebuilt without this trainer is no more current than one with a higher generation.
    if (!usable(after, generation, trainerItemId)) {
      return { kind: 'linked_but_stale', trainerItemId };
    }
  } catch (error) {
    return {
      kind: 'linked_unverified',
      trainerItemId,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return { kind: 'linked' };
}
