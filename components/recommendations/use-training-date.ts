'use client';

import { useEffect, useState } from 'react';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { formatTrainingDate, readTrainingDate } from './training-date';

import type { MondayBridge } from './monday-client';

/**
 * The date of the training on screen, read as the logged-in planner.
 *
 * Same route as the trainer names and the relation: Monday itself, through the SDK
 * bridge, so the planner's own board permissions apply and our backend token stays out
 * of it. One column, one item — the cheapest read in the view.
 */

const DATE_QUERY = `
query ($ids: [ID!], $cols: [String!]) {
  items(ids: $ids) {
    id
    column_values(ids: $cols) {
      id
      ... on DateValue { date }
    }
  }
}`;

export interface TrainingDate {
  /** `YYYY-MM-DD`, or null while unknown. */
  iso: string | null;
  /** The date as the header shows it, or null when there is nothing to show. */
  label: string | null;
  loading: boolean;
}

/**
 * The answer, tagged with the training it describes.
 *
 * The same rule `useRecommendationView` states for its own state, and for the same
 * reason: **the iframe is not remounted when the planner clicks the next training.** Only
 * the context changes, so React renders the new item while this still holds the previous
 * one's date, and an effect cannot clear it soon enough — effects run after the commit,
 * so that render is painted. The header is not masked while the list reloads, which would
 * put training A's date under training B's heading for exactly as long as it takes Monday
 * to answer.
 */
type OwnedDate = TrainingDate & { itemId: string | null };

const NOTHING: OwnedDate = { itemId: null, iso: null, label: null, loading: false };

/** A value tagged for another item is not this item's answer — it is a pending one. */
function currentDate(state: OwnedDate, itemId: string | null): TrainingDate {
  if (state.itemId !== itemId) {
    return { iso: null, label: null, loading: itemId !== null };
  }
  return { iso: state.iso, label: state.label, loading: state.loading };
}

export function useTrainingDate(monday: MondayBridge, itemId: string | null): TrainingDate {
  const [state, setState] = useState<OwnedDate>(NOTHING);

  useEffect(() => {
    if (itemId === null) {
      setState(NOTHING);
      return;
    }

    let cancelled = false;
    setState({ itemId, iso: null, label: null, loading: true });

    monday
      .api(DATE_QUERY, { ids: [itemId], cols: [AGENDA_2026_COLUMNS.datum] })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const iso = readTrainingDate(data, AGENDA_2026_COLUMNS.datum);
        setState({ itemId, iso, label: formatTrainingDate(iso), loading: false });
      })
      .catch(() => {
        // Silent by design — see `readTrainingDate`. A date that cannot be read is a
        // header line left out, and an unusable date on the board is already reported
        // where it counts: the run fails with `invalid_date` and the view says so.
        if (!cancelled) {
          setState({ itemId, iso: null, label: null, loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [itemId, monday]);

  return currentDate(state, itemId);
}
