'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type RecommendationsApi } from './api';
import { readLinkedTrainers } from './linked-trainers';
import { pickTrainer } from './pick-trainer';
import type { Appearance, MondayBridge, MondayContext } from './monday-client';
import type { RecommendationView } from './types';

/**
 * The view's state machine: which item, what it says, and when to ask again.
 *
 * Everything here follows from one fact about a Monday item view: **the iframe is not
 * remounted when the planner clicks the next training.** Only the context changes, so
 * every piece of state and every in-flight request belongs to an item that may no longer
 * be the one on screen. Two mechanisms carry that through:
 *
 * - **State is tagged with its owner.** `status` records which item it describes, and a
 *   value tagged for a different item reads as `loading`. A passive effect cannot clear
 *   it soon enough: React renders the new context before effects run, so for one render
 *   `itemId` would be B while the rows are still A's — long enough for a click to send
 *   A's trainer and generation to B.
 * - **One action at a time, identified by a token.** Recalculate, Pick and Benaderd take
 *   the same lock, and each releases it only if it still holds it. Otherwise A's
 *   recalculate finishing during B's would clear B's flag and unlock the UI mid-write.
 */

/** Slow enough not to hammer the API, fast enough that a 10–40s compute feels live. */
const COMPUTING_POLL_MS = 3_000;

/**
 * A `ready` list is SHARED state and keeps changing without this browser doing anything:
 * another planner ticks `Benaderd`, recalculates, or links a trainer. Polling only while
 * `computing` would leave a settled view frozen at whatever it saw first.
 */
const READY_POLL_MS = 20_000;

export type ViewStatus =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; view: RecommendationView };

/** Internally every status carries the item it describes; callers see only current ones. */
type OwnedStatus = ViewStatus & { itemId: string | null };

/**
 * What we know about the trainer relation on the Monday item.
 *
 * `unknown` is a state, not an empty list, because the two license opposite actions: an
 * empty relation means "nobody is linked, go ahead", while not knowing means "a
 * colleague may already have chosen". Treating the second as the first is exactly how
 * one planner overwrites another's pick.
 */
export type LinkedState =
  | { kind: 'unknown' }
  | { kind: 'ready'; trainerItemIds: readonly string[] }
  | { kind: 'error'; message: string };

export interface UseRecommendationView {
  itemId: string | null;
  /** Null until Monday's context has arrived — never a guessed default. */
  theme: Appearance | null;
  status: ViewStatus;
  recalculating: boolean;
  recalculate: () => Promise<void>;
  setApproached: (trainerItemId: string, approached: boolean) => Promise<void>;
  /** Link this trainer to the training, as the logged-in planner. */
  pick: (trainerItemId: string) => Promise<void>;
  /** The trainer being linked right now, so only that row's button spins. */
  picking: string | null;
  /**
   * True while ANY generation-sensitive action is in flight — Benaderd included.
   *
   * One lock rather than one per action: a recalculate running alongside a pick can
   * advance the generation between the pick's own before- and after-checks, so both pass
   * while the trainer came from the superseded list.
   */
  busy: boolean;
  linked: LinkedState;
  refresh: () => Promise<void>;
  /** Clear `stale` and reload — the way out of a frozen view without reopening it. */
  reset: () => Promise<void>;
  /** Set once the list on screen is known to be superseded. Every control freezes. */
  stale: boolean;
  warning: string | null;
  dismissWarning: () => void;
}

export function useRecommendationView(
  monday: MondayBridge,
  api: RecommendationsApi,
  options: { pollIntervalMs?: number; readyPollIntervalMs?: number } = {}
): UseRecommendationView {
  const computingPollMs = options.pollIntervalMs ?? COMPUTING_POLL_MS;
  const readyPollMs = options.readyPollIntervalMs ?? READY_POLL_MS;

  const [context, setContext] = useState<MondayContext | null>(null);
  const [owned, setOwned] = useState<OwnedStatus>({ kind: 'loading', itemId: null });
  const [linkedFor, setLinkedFor] = useState<{ itemId: string | null; state: LinkedState }>({
    itemId: null,
    state: { kind: 'unknown' },
  });
  const [action, setAction] = useState<{ token: number; trainerItemId: string | null } | null>(
    null
  );
  const [recalculating, setRecalculating] = useState(false);
  const [staleFor, setStaleFor] = useState<string | null>(null);
  const [warningFor, setWarningFor] = useState<{ itemId: string; message: string } | null>(null);

  const actionIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const tokenRef = useRef(0);

  const itemId = context?.itemId ?? null;
  const boardId = context?.boardId ?? null;

  /**
   * Derived, not stored. A value tagged for another item reads as `loading`, which
   * closes the window between React rendering the new context and any effect running.
   */
  const status: ViewStatus = useMemo(
    () => (owned.itemId === itemId ? owned : { kind: 'loading' }),
    [itemId, owned]
  );
  const linked: LinkedState = useMemo(
    () => (linkedFor.itemId === itemId ? linkedFor.state : { kind: 'unknown' }),
    [itemId, linkedFor]
  );
  const stale = staleFor !== null && staleFor === itemId;
  const warning = warningFor !== null && warningFor.itemId === itemId ? warningFor.message : null;

  useEffect(() => {
    let cancelled = false;
    /**
     * A context CHANGE outranks the initial read, whenever they arrive. `context()` is a
     * promise and `listen('context')` a callback, so a planner who clicks the next
     * training while the first read is in flight would otherwise be dragged back by the
     * late resolution.
     */
    let sawChange = false;

    monday
      .context()
      .then((next) => {
        if (!cancelled && !sawChange) {
          setContext(next);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOwned({ kind: 'error', message: describe(error), itemId: null });
        }
      });

    const unsubscribe = monday.onContextChange((next) => {
      if (!cancelled) {
        sawChange = true;
        setContext(next);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [monday]);

  useEffect(() => {
    revisionRef.current += 1;
    actionIdRef.current = null;
    setAction(null);
    setRecalculating(false);
  }, [itemId]);

  /**
   * `revision` is the one the CALLER started under, not the one current when the load
   * begins. An action for item A can finish after the planner switched to B and then
   * call its A-bound `load`, which would otherwise adopt B's revision.
   */
  const load = useCallback(
    async (signal?: AbortSignal, revision?: number): Promise<RecommendationView | null> => {
      if (itemId === null) {
        return null;
      }
      const owner = itemId;
      const startedAt = revision ?? revisionRef.current;
      const stillCurrent = (): boolean =>
        startedAt === revisionRef.current && signal?.aborted !== true;

      try {
        const view = await api.get(owner, signal);
        if (stillCurrent()) {
          setOwned({ kind: 'loaded', view, itemId: owner });
        }
        return view;
      } catch (error) {
        if (stillCurrent()) {
          setOwned({ kind: 'error', message: describe(error), itemId: owner });
        }
        return null;
      }
    },
    [api, itemId]
  );

  /**
   * The relation, read straight from Monday — our API knows nothing about a link it
   * never wrote. A failure is RECORDED, not swallowed: "we could not find out" must
   * never render as "nobody is linked".
   */
  const loadLinked = useCallback(
    async (revision: number) => {
      if (itemId === null) {
        return;
      }
      const owner = itemId;
      try {
        const trainerItemIds = await readLinkedTrainers(monday, owner);
        if (revision === revisionRef.current) {
          setLinkedFor({ itemId: owner, state: { kind: 'ready', trainerItemIds } });
        }
      } catch (error) {
        if (revision === revisionRef.current) {
          setLinkedFor({ itemId: owner, state: { kind: 'error', message: describe(error) } });
        }
      }
    },
    [itemId, monday]
  );

  // Fetch, then keep polling — fast while computing, slow once settled. The relation
  // rides along, so a colleague's link appears without this planner doing anything.
  useEffect(() => {
    if (itemId === null) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      const revision = revisionRef.current;
      const [view] = await Promise.all([load(controller.signal, revision), loadLinked(revision)]);
      if (controller.signal.aborted) {
        return;
      }
      const delay = view?.state.kind === 'computing' ? computingPollMs : readyPollMs;
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    void tick();

    return () => {
      controller.abort();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [computingPollMs, itemId, load, loadLinked, readyPollMs]);

  const warn = useCallback((owner: string, message: string) => {
    setWarningFor({ itemId: owner, message });
  }, []);

  /** Take the single action lock, or report that someone else holds it. */
  const acquire = useCallback(
    (trainerItemId: string | null): number | null => {
      if (action !== null) {
        return null;
      }
      tokenRef.current += 1;
      const token = tokenRef.current;
      setAction({ token, trainerItemId });
      return token;
    },
    [action]
  );

  /** Release only if we still hold it — an older action must not unlock a newer one. */
  const release = useCallback((token: number) => {
    setAction((held) => (held !== null && held.token === token ? null : held));
  }, []);

  const refresh = useCallback(async () => {
    const revision = revisionRef.current;
    await Promise.all([load(undefined, revision), loadLinked(revision)]);
  }, [load, loadLinked]);

  /**
   * The way out of `stale` — and it stays frozen until a fresh list actually arrives.
   * Unfreezing first would re-enable the controls over the very rows just declared
   * superseded, and a failed reload would leave them enabled with nothing replaced.
   */
  const reset = useCallback(async () => {
    const owner = itemId;
    const revision = revisionRef.current;
    setWarningFor(null);

    const view = await load(undefined, revision);
    if (view !== null && revision === revisionRef.current && owner !== null) {
      setStaleFor((frozen) => (frozen === owner ? null : frozen));
    }
    await loadLinked(revision);
  }, [itemId, load, loadLinked]);

  const recalculate = useCallback(async () => {
    if (itemId === null) {
      return;
    }
    const owner = itemId;
    const revision = revisionRef.current;
    const token = acquire(null);
    if (token === null) {
      return;
    }

    // A new id only for a deliberate press; a retry after a failure reuses the last one.
    actionIdRef.current ??= newActionId();
    setRecalculating(true);
    try {
      await api.recalculate(owner, actionIdRef.current);
      if (revision === revisionRef.current) {
        actionIdRef.current = null;
        // Our own recalculate is not staleness — this planner asked for the new list.
        setStaleFor((frozen) => (frozen === owner ? null : frozen));
      }
      await load(undefined, revision);
      await loadLinked(revision);
    } catch (error) {
      if (revision === revisionRef.current) {
        warn(owner, describe(error));
      }
    } finally {
      // Scoped: A's recalculate finishing during B's must not unlock B.
      if (revision === revisionRef.current) {
        setRecalculating(false);
      }
      release(token);
    }
  }, [acquire, api, itemId, load, loadLinked, release, warn]);

  const setApproached = useCallback(
    async (trainerItemId: string, approached: boolean) => {
      const state = status.kind === 'loaded' ? status.view.state : null;
      if (itemId === null || state === null || state.kind !== 'ready') {
        return;
      }
      const owner = itemId;
      const revision = revisionRef.current;
      // Benaderd takes the same lock: it targets a generation like everything else.
      const token = acquire(null);
      if (token === null) {
        return;
      }

      try {
        await api.setApproached(owner, {
          generation: state.generation,
          trainerItemId,
          approached,
        });
      } catch (error) {
        if (revision === revisionRef.current) {
          if (error instanceof ApiError && error.status === CONFLICT) {
            setStaleFor(owner);
            warn(owner, 'Deze lijst is verouderd — de aanbevelingen zijn opnieuw berekend.');
          } else {
            warn(owner, describe(error));
          }
        }
      }

      await load(undefined, revision);
      release(token);
    },
    [acquire, api, itemId, load, release, status, warn]
  );

  const pick = useCallback(
    async (trainerItemId: string) => {
      const state = status.kind === 'loaded' ? status.view.state : null;
      if (itemId === null || boardId === null || state === null || state.kind !== 'ready') {
        return;
      }
      // Never act on an unknown relation: a colleague may already have chosen, and we
      // would be overwriting them.
      if (linked.kind !== 'ready') {
        return;
      }
      const owner = itemId;
      const revision = revisionRef.current;
      const token = acquire(trainerItemId);
      if (token === null) {
        return;
      }

      try {
        const outcome = await pickTrainer(
          { monday, api, boardId },
          { mondayItemId: owner, generation: state.generation, trainerItemId }
        );

        if (revision !== revisionRef.current) {
          return;
        }

        switch (outcome.kind) {
          case 'refused':
            setStaleFor(owner);
            warn(
              owner,
              'Deze lijst is verouderd — er is inmiddels opnieuw berekend. De trainer is NIET ' +
                'gekoppeld. Ververs de lijst en kies opnieuw.'
            );
            break;
          case 'linked_but_stale':
            // Detected, not repaired: the relation IS set, and reversing a planner's
            // write would be worse than the staleness.
            setStaleFor(owner);
            warn(
              owner,
              `Trainer #${outcome.trainerItemId} is gekoppeld, maar de lijst werd tijdens het ` +
                'koppelen opnieuw berekend. Controleer of deze trainer nog de juiste keuze is.'
            );
            break;
          case 'linked_unverified':
            warn(
              owner,
              `Trainer #${outcome.trainerItemId} is gekoppeld, maar de lijst kon daarna niet ` +
                `worden gecontroleerd (${outcome.message}). Ververs om de status te zien.`
            );
            break;
          case 'failed':
            warn(owner, `Koppelen is niet gelukt: ${outcome.message}`);
            break;
          case 'linked':
            break;
        }

        // Record the link BEFORE the lock is released, so there is no window in which
        // the buttons are live again while the relation still looks empty.
        if (outcome.kind !== 'refused' && outcome.kind !== 'failed') {
          setLinkedFor((held) =>
            held.itemId === owner && held.state.kind === 'ready'
              ? {
                  itemId: owner,
                  state: {
                    kind: 'ready',
                    trainerItemIds: [...new Set([...held.state.trainerItemIds, trainerItemId])],
                  },
                }
              : held
          );
        }

        // Monday first: it is the only source that knows the relation changed.
        await loadLinked(revision);
        await load(undefined, revision);
      } finally {
        release(token);
      }
    },
    [acquire, api, boardId, itemId, linked.kind, load, loadLinked, monday, release, status, warn]
  );

  return useMemo(
    () => ({
      itemId,
      theme: context?.theme ?? null,
      status,
      recalculating,
      recalculate,
      setApproached,
      pick,
      picking: action?.trainerItemId ?? null,
      busy: action !== null,
      linked,
      stale,
      refresh,
      reset,
      warning,
      dismissWarning: () => {
        setWarningFor(null);
      },
    }),
    [
      action,
      context?.theme,
      itemId,
      linked,
      pick,
      recalculate,
      recalculating,
      refresh,
      reset,
      setApproached,
      stale,
      status,
      warning,
    ]
  );
}

const CONFLICT = 409;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `crypto.randomUUID` is available in every browser Monday supports. */
function newActionId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 32);
}
