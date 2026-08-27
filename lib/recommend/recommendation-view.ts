import type { ApproachedStore } from './approached';
import type { Capabilities } from './capabilities';
import type { StatusLabel } from './delivery';
import type { OutcomeStore } from './outcome';
import type { QueueStore } from './queue-store';
import { log } from '@lib/logger';

import { conflictsFor, countsFor } from './assignments';

import type { DayConflict } from './assignments';
import {
  toPublicRows,
  type DayConflictLookup,
  type PublicRow,
  type WorkloadLookup,
} from './view-dto';

/** Workload and day conflicts come from one scan, so they are resolved from one `peek`. */
interface ScanLookups {
  workload: WorkloadLookup;
  dayConflicts: DayConflictLookup;
}
import type { CachedAssignments } from './assignment-cache';

/**
 * What the item view is looking at right now.
 *
 * The hard part is not fetching the rows; it is telling the four ways there can be no
 * rows apart from one another. A spinner shown for a year-old training, or an error
 * shown for a training nobody has queued, are both worse than saying nothing — so every
 * state here is derived from evidence rather than from the absence of it:
 *
 * | state | evidence |
 * |---|---|
 * | `idle` | no generation has ever been allocated |
 * | `computing` | generation `G` exists, no label, and the watermark is `< G` |
 * | `ready` / `no_match` / `failed` | the rows are present and say so |
 * | `unavailable` | a label exists but its rows do not — expired, or written before they were kept |
 *
 * `unavailable` is the state that needs the watermark. Once rows expire, "label exists,
 * rows gone" and "still computing" look identical from the outside, and a planner would
 * watch a spinner that can never resolve. The watermark is durable precisely so that
 * question stays answerable after the data it describes is gone.
 */

export type ViewState =
  | { kind: 'idle' }
  | { kind: 'computing'; generation: number }
  | {
      kind: 'ready';
      generation: number;
      rows: PublicRow[];
      /**
       * The training's duration in hours, for the header above the list. Null when the
       * board's `duur` column is empty or the rows predate the field.
       */
      duurTraining: number | null;
      /**
       * `'city'` when Locatie named only a town, so every distance below was measured to
       * that town's centre. Null when the destination was a real address, and on lists
       * written before this was recorded.
       */
      travelPrecision: 'city' | null;
    }
  | { kind: 'no_match'; generation: number }
  /** `stage` names where it broke — `travel`, `monday`, `dlq_exhausted`. */
  | { kind: 'failed'; generation: number; stage: string }
  | { kind: 'unavailable'; generation: number; label: StatusLabel };

/**
 * What the client is told it may do.
 *
 * Without this the view cannot tell a `view` user from a `plan` user — both receive
 * `RestrictedRow` — and would render Recalculate and `Benaderd` controls that 403 on
 * click. It is presentation only: the server checks the same capabilities again on every
 * mutating route, and `canPlan` here is never what authorizes anything.
 */
export interface ViewCapabilities {
  canPlan: boolean;
  canViewFull: boolean;
}

export interface RecommendationView {
  state: ViewState;
  caps: ViewCapabilities;
}

export interface ViewDeps {
  queue: Pick<QueueStore, 'readGeneration'>;
  outcomes: Pick<OutcomeStore, 'read' | 'readDetail' | 'readCompletedGeneration'>;
  approached: ApproachedStore;
  /**
   * Current workload, resolved HERE rather than stored with the rows.
   *
   * Optional, and a failure is swallowed into `null` counts: the scan fails closed on
   * malformed Monday data (as it must — an empty index is indistinguishable from "nobody
   * is busy"), but that must not take down a list that is otherwise perfectly readable
   * from Redis. The columns render `—`, which already means "not recorded".
   */
  assignments?: CachedAssignments;
  /**
   * Hand a background task to the platform so it outlives the response — `waitUntil`.
   *
   * Only used to warm a cold workload cache. Optional because nothing depends on it:
   * without it the miss simply stays a miss until the cron's next run, which is at most
   * the cron interval. A floating promise instead of this would be killed the moment the
   * serverless response is flushed, so the scan would be started and never finished —
   * the same Monday cost as a real refresh, with none of the benefit.
   */
  warm?: (task: Promise<unknown>) => void;
}

export function viewCapabilities(caps: Capabilities): ViewCapabilities {
  return { canPlan: caps.plan, canViewFull: caps.full };
}

/**
 * How many times to re-resolve when the generation moves underneath us.
 *
 * Three is a bound, not a probability estimate: recalculations are human-paced, so
 * losing twice in a row means something is actively churning, and the honest answer then
 * is `computing` rather than a fourth attempt.
 */
const MAX_RESOLVE_ATTEMPTS = 3;

export async function resolveView(
  deps: ViewDeps,
  mondayItemId: string,
  caps: Capabilities
): Promise<RecommendationView> {
  return {
    state: await resolveStableState(deps, mondayItemId, caps),
    caps: viewCapabilities(caps),
  };
}

/**
 * Resolve, then confirm the generation did not move while we were reading it.
 *
 * Reading the generation and then reading its rows is not atomic, so a recalculate
 * landing in between would have us return generation `G` as `ready` when the current
 * generation is already `G+1`. That is not a cosmetic staleness: the pick flow re-reads
 * this endpoint immediately before writing the trainer relation precisely to catch a
 * recalculate, and a response that can itself be stale makes that check a formality.
 *
 * The `approached` route would disagree too — it validates against the CURRENT
 * generation, so the planner would be looking at a list whose ticks 409.
 */
async function resolveStableState(
  deps: ViewDeps,
  mondayItemId: string,
  caps: Capabilities
): Promise<ViewState> {
  let generation = await deps.queue.readGeneration(mondayItemId);

  for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
    const state = await resolveState(deps, mondayItemId, generation, caps);

    const current = await deps.queue.readGeneration(mondayItemId);
    if (current === generation) {
      return state;
    }
    generation = current;
  }

  // Still moving. `computing` is true — a newer generation exists and has not been
  // answered yet — and it makes the client poll rather than act on a list that is
  // already superseded.
  return { kind: 'computing', generation };
}

async function resolveState(
  deps: ViewDeps,
  mondayItemId: string,
  generation: number,
  caps: Capabilities
): Promise<ViewState> {
  if (generation === 0) {
    // Never triggered. Not an error, and not something to spin on: the training has
    // simply never been moved into a planning group.
    return { kind: 'idle' };
  }

  const detail = await deps.outcomes.readDetail(mondayItemId, generation);

  if (detail === null) {
    const label = await deps.outcomes.read(mondayItemId, generation);
    if (label !== null) {
      // A label with no rows: written before rows were kept, or they have expired.
      // Either way there is nothing to show and never will be — offer a recalculate,
      // not a spinner.
      return { kind: 'unavailable', generation, label };
    }

    const completed = await deps.outcomes.readCompletedGeneration(mondayItemId);
    // The watermark should never have reached this generation without a label, since
    // labels do not expire. If it somehow has, the honest answer is "gone", because
    // `computing` would be a promise nothing is going to keep.
    return completed < generation
      ? { kind: 'computing', generation }
      : { kind: 'unavailable', generation, label: 'FOUT' };
  }

  if (detail.kind === 'failed') {
    // The stage travels; the message does not. Messages carry provider text and internal
    // detail, and the view only needs to say which step gave up.
    return { kind: 'failed', generation, stage: detail.failure.stage };
  }

  if (detail.kind === 'no_match') {
    return { kind: 'no_match', generation };
  }

  const marked = await deps.approached.read(
    mondayItemId,
    generation,
    detail.rows.map((row) => row.trainerItemId)
  );

  const { workload, dayConflicts } = await resolveWorkload(
    deps,
    mondayItemId,
    detail.trainingMonth,
    caps
  );

  return {
    kind: 'ready',
    generation,
    rows: toPublicRows(detail.rows, marked, caps, workload, dayConflicts),
    duurTraining: detail.duurTraining,
    // Only a caller who can see the travel columns can be misled by them.
    travelPrecision: caps.full ? detail.travelPrecision : null,
  };
}

/**
 * Current workload per trainer, or a lookup that answers `null` for everyone.
 *
 * Only for `full` callers — the restricted shape has no workload columns, so a restricted
 * planner's page view must not trigger a board scan on their behalf.
 */
async function resolveWorkload(
  deps: ViewDeps,
  mondayItemId: string,
  storedMonth: string | null,
  caps: Capabilities
): Promise<ScanLookups> {
  const none: ScanLookups = { workload: () => null, dayConflicts: () => [] };
  /**
   * `plan` is genoeg voor de dagbotsingen, `full` blijft nodig voor de werklastkolommen.
   *
   * Die twee hangen aan verschillende dingen: de kolommen tonen tarieven en kosten, het
   * label toont een datum en een klantnaam die al op het bord staan. Ze samen achter
   * `full` zetten laat precies de gebruiker die op Kies drukt de waarschuwing missen.
   */
  if (deps.assignments === undefined || !(caps.full || caps.plan)) {
    return none;
  }
  try {
    /**
     * `peek`, not `read` — the request never scans Monday itself.
     *
     * `read` would block this response for as long as the scan takes, which is the
     * 5.5–8.5 seconds that made the columns a coin flip in the first place. The refresh
     * cron owns filling this cache; all a request does is use what is there, and on a
     * miss ask for a refresh it will not wait for.
     */
    const peeked = await deps.assignments.peek();
    if (peeked.kind !== 'hit') {
      /**
       * `miss` warms the cache for the next caller; `failed` deliberately does not.
       * That sentinel means a refresh just failed, and its short TTL is what stops
       * every poll — the view refreshes every 20 seconds, from every open tab — from
       * starting the same doomed scan for as long as Monday is down.
       */
      /**
       * Alleen een `full`-lezer warmt de cache op.
       *
       * De oorspronkelijke regel was dat een beperkte lezer nooit een bordscan op zijn
       * naam mag starten. Die regel blijft letterlijk overeind: hij leest wat er ligt en
       * ziet bij een misser geen label, maar hij zet geen scan in gang.
       */
      if (peeked.kind === 'miss' && caps.full) {
        deps.warm?.(deps.assignments.refresh());
      }
      return none;
    }
    const scan = peeked.value;
    /**
     * The training's CURRENT month, from the same scan — not the one stored with the
     * rows. Rescheduling from September to October does not advance the generation, so a
     * frozen month would keep counting October's trainers against September. The stored
     * month is only a fallback for an item the scan did not cover.
     */
    /**
     * Three cases, and only one of them may fall back.
     *
     * Scanned with a date → use it. Scanned WITHOUT one (the planner cleared it) → we
     * know there is no month, so the answer is unknown, not the stale one the rows were
     * computed with. Not scanned at all (deleted, moved, or outside the board) → the
     * stored month is the best we have.
     */
    const scanned = scan.monthByItemId.has(mondayItemId);
    const month = scanned ? scan.monthByItemId.get(mondayItemId) : storedMonth;
    if (month === null || month === undefined) {
      return none;
    }
    /**
     * The day comes from the SAME scan, and only from it.
     *
     * There is no stored fallback for the date the way there is for the month, and that is
     * the honest outcome: an item the scan did not cover has no day we can trust, so it
     * reports no conflicts rather than guessing from a stale one. `conflictsFor` drops the
     * training itself, or every linked trainer would collide with the very session on
     * screen.
     */
    const day = scan.dateByItemId.get(mondayItemId) ?? null;

    /**
     * De klantnaam gaat er voor IEDEREEN af; het tijdstip alleen voor wie `full` heeft.
     *
     * De klantnaam is eruit op verzoek van ITG (27-Aug-2026, via Peter): hij maakte de
     * regel druk zonder de planner iets te vertellen wat hij niet al wist. Dat hij ook de
     * enige echt gevoelige inhoud was — de naam van een dérde partij — is meegenomen: de
     * scan leest hem nog wel, maar hij verlaat de server niet meer.
     *
     * Het tijdstip blijft achter `full`. `plan` zegt namelijk niets over toegang tot het
     * agendabord — de standaardrechten zijn account-breed en niet bord-gebonden, dus een
     * `plan`-houder kan iemand zijn die dat bord helemaal niet mag openen. Zie
     * `capabilities.ts`.
     *
     * Wat een `plan`-houder overhoudt is "deze trainer staat die dag al ergens", en dat is
     * precies wat de waarschuwing moet doen bij de knop die eraan hangt. Het label maakt
     * daar vanzelf "Al ingepland" van — dezelfde weg als een hernoemde kolom.
     */
    const zichtbaar = (botsing: DayConflict): DayConflict => ({
      itemId: botsing.itemId,
      client: null,
      times: caps.full ? botsing.times : null,
    });
    return {
      // De kolommen blijven `full`-only; alleen het label zakt door naar `plan`.
      workload: caps.full
        ? (trainerItemId) => countsFor(scan.workload, trainerItemId, month)
        : () => null,
      dayConflicts:
        day === null
          ? () => []
          : (trainerItemId) => conflictsFor(scan, trainerItemId, day, mondayItemId).map(zichtbaar),
    };
  } catch (error) {
    // Degrade, never zero: the list is still correct and worth showing.
    log.warn('recommendations: workload unavailable, rendering it as unknown', {
      message: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}
