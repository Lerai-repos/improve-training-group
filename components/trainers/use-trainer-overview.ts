'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTrainerNames } from '@components/recommendations/use-trainer-names';

import { useRoster } from './use-roster';

import type { Appearance, MondayBoardBridge } from '@components/recommendations/monday-client';
import type { TrainerOverviewPayload } from '@lib/evaluations';
import type { TrainerOverviewApi } from './api';

/**
 * Loading the roster, and resolving the names for it.
 *
 * Data only — the filter, the sort and which rows are unfolded live in the view, because
 * none of them survive a reload and none of them need to.
 *
 * The names come from Monday in the browser, as the logged-in planner, exactly as the
 * recommendations tab does it: the server stores ids and numbers and never a name, so a
 * breach of the key/value store yields opaque identifiers rather than a list of people
 * and their scores.
 *
 * Two different lookups, because the two id kinds live on different boards. Trainers come
 * from `useRoster`, which reads the board this tab is a view OF — that hands back the
 * whole roster and its names in one go, which is what lets the table show trainers the
 * statistics record says nothing about. Themes come from `useTrainerNames`, reused rather
 * than copied for its `items(ids:)` batching and the `limit` trap that silently caps a
 * reply at 25.
 */

export type OverviewStatus = 'loading' | 'ready' | 'error';

export interface TrainerOverviewState {
  readonly status: OverviewStatus;
  readonly payload: TrainerOverviewPayload | null;
  readonly error: string | null;
  readonly names: ReadonlyMap<string, string>;
  readonly themeNames: ReadonlyMap<string, string>;
  /** Every trainer on the board; empty when the roster could not be read. */
  readonly rosterIds: readonly string[];
  /**
   * Monday's own light/dark setting, or null until it has told us.
   *
   * Carried rather than assumed: this page renders inside their iframe over their canvas,
   * and guessing light in a dark workspace paints dark text on a dark background.
   */
  readonly theme: Appearance | null;
  /** The context read failed, so the theme will never arrive. Not the same as "not yet". */
  readonly themeUnavailable: boolean;
  /** Set when Monday answered short or not at all; the table shows ids and says why. */
  readonly nameWarning: string | null;
  readonly reload: () => void;
}

export function useTrainerOverview(
  monday: MondayBoardBridge,
  api: TrainerOverviewApi
): TrainerOverviewState {
  const [payload, setPayload] = useState<TrainerOverviewPayload | null>(null);
  const [status, setStatus] = useState<OverviewStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Appearance | null>(null);
  const [themeUnavailable, setThemeUnavailable] = useState(false);

  /**
   * The board this tab is a view of — which IS the roster, so it is read once and reused
   * rather than configured. `onContextChange` is subscribed to for the same reason the
   * item views do it: Monday can swap the context under a mounted view.
   */
  useEffect(() => {
    let cancelled = false;
    /**
     * A context CHANGE outranks the initial read, whenever they arrive.
     *
     * `context()` is a promise and `listen('context')` a callback, so if Monday moves the
     * view to another board while the first read is still in flight, the late resolution
     * would drag us back and load the previous board's roster. Same guard the
     * recommendations hook already carries, for the same reason.
     */
    let sawChange = false;

    monday
      .context()
      .then((context) => {
        if (!cancelled && !sawChange) {
          setBoardId(context.boardId);
          setTheme(context.theme);
        }
      })
      .catch(() => {
        /**
         * Not fatal for the data — the table still renders from the statistics, with
         * fewer trainers and every number correct. It IS fatal for the theme, and that
         * has to be said out loud rather than left as "still loading": the view would
         * otherwise wait forever for a colour scheme that is never coming.
         */
        if (!cancelled) {
          setThemeUnavailable(true);
        }
      });

    const unsubscribe = monday.onContextChange((context) => {
      if (!cancelled) {
        sawChange = true;
        setBoardId(context.boardId);
        setTheme(context.theme);
        setThemeUnavailable(false);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [monday]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');

    api
      .get(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) {
          return;
        }
        setPayload(next);
        setError(null);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      });

    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  const trainers = payload?.trainers ?? [];
  /**
   * Every theme id across the whole roster, deduplicated — one query rather than one per
   * trainer as rows are unfolded, which would put a Monday round trip behind every click.
   */
  const themeIds = [...new Set(trainers.flatMap((row) => row.themes.map((t) => t.themaExternalId)))];

  const roster = useRoster(monday, boardId);
  const themeNames = useTrainerNames(monday, themeIds);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    status,
    payload,
    error,
    names: roster.names,
    themeNames: themeNames.byId,
    rosterIds: roster.ids,
    theme,
    themeUnavailable,
    nameWarning: roster.error ?? themeNames.error,
    reload,
  };
}
