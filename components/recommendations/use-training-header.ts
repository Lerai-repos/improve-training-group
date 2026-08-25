'use client';

import { useEffect, useState } from 'react';

import { EMPTY_HEADER, HEADER_COLUMN_IDS, readTrainingHeader } from './training-header';

import type { TrainingHeader } from './training-header';
import type { MondayBridge } from './monday-client';

/**
 * The details of the training on screen, read as the logged-in planner.
 *
 * Same route as the trainer names and the relation: Monday itself, through the SDK
 * bridge, so the planner's own board permissions apply and our backend token stays out
 * of it. One item, six columns — still the cheapest read in the view.
 */

const HEADER_QUERY = `
query ($ids: [ID!], $cols: [String!]) {
  items(ids: $ids) {
    id
    column_values(ids: $cols) {
      id
      text
      ... on MirrorValue { display_value }
      ... on BoardRelationValue { display_value }
      ... on DateValue { date }
    }
  }
}`;

export interface TrainingHeaderState {
  header: TrainingHeader;
  loading: boolean;
}

/**
 * The answer, tagged with the training it describes.
 *
 * The same rule `useRecommendationView` states for its own state, and for the same
 * reason: **the iframe is not remounted when the planner clicks the next training.** Only
 * the context changes, so React renders the new item while this still holds the previous
 * one's details, and an effect cannot clear it soon enough — effects run after the
 * commit, so that render is painted. The header is not masked while the list reloads,
 * which would put training A's client and location under training B's heading for exactly
 * as long as it takes Monday to answer.
 */
type OwnedHeader = TrainingHeaderState & { itemId: string | null };

const NOTHING: OwnedHeader = { itemId: null, header: EMPTY_HEADER, loading: false };

/** A value tagged for another item is not this item's answer — it is a pending one. */
function currentHeader(state: OwnedHeader, itemId: string | null): TrainingHeaderState {
  if (state.itemId !== itemId) {
    return { header: EMPTY_HEADER, loading: itemId !== null };
  }
  return { header: state.header, loading: state.loading };
}

export function useTrainingHeader(
  monday: MondayBridge,
  itemId: string | null
): TrainingHeaderState {
  const [state, setState] = useState<OwnedHeader>(NOTHING);

  useEffect(() => {
    if (itemId === null) {
      setState(NOTHING);
      return;
    }

    let cancelled = false;
    setState({ itemId, header: EMPTY_HEADER, loading: true });

    monday
      .api(HEADER_QUERY, { ids: [itemId], cols: [...HEADER_COLUMN_IDS] })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setState({ itemId, header: readTrainingHeader(data), loading: false });
      })
      .catch(() => {
        // Silent by design — see `readTrainingHeader`. Details that cannot be read are
        // header lines left out, and anything that actually blocks a recommendation is
        // already reported where it counts: the run fails and the view says so.
        if (!cancelled) {
          setState({ itemId, header: EMPTY_HEADER, loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [itemId, monday]);

  return currentHeader(state, itemId);
}
