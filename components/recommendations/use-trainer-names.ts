'use client';

import { useEffect, useState } from 'react';

import type { MondayBridge } from './monday-client';

/**
 * Trainer names, resolved in the browser.
 *
 * The server stores item ids and numbers only — never a name — so that a breach of the
 * key/value store yields opaque identifiers rather than a list of people, their rates
 * and their scores. The names therefore have to come from somewhere at render time, and
 * the right somewhere is Monday itself, read **as the logged-in planner**: their board
 * permissions apply, and our backend token is never involved.
 *
 * A failure here degrades rather than breaks — the table falls back to showing ids, which
 * is ugly but still ranked and still correct. Monday viewers reportedly cannot call the
 * API at all; if that holds, this is exactly what they will see, and it is the reason the
 * app spike checks it before anyone is told the feature works for them.
 */

const NAMES_QUERY = `query ($ids: [ID!]) { items(ids: $ids) { id name } }`;

/**
 * Pull `{ id, name }` pairs out of whatever came back.
 *
 * Written as a walk over `unknown` rather than a cast: this is the one response shaped
 * by Monday rather than by us, and a query that partially failed still returns a
 * well-formed envelope with pieces missing.
 */
function readNames(data: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    return names;
  }
  const { items } = data;
  if (!Array.isArray(items)) {
    return names;
  }
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('name' in item)) {
      continue;
    }
    const { id, name } = item;
    if ((typeof id === 'string' || typeof id === 'number') && typeof name === 'string') {
      names.set(String(id), name);
    }
  }
  return names;
}

export interface TrainerNames {
  byId: ReadonlyMap<string, string>;
  loading: boolean;
  /** Set when the lookup failed; the table shows ids and says why. */
  error: string | null;
}

export function useTrainerNames(monday: MondayBridge, trainerItemIds: string[]): TrainerNames {
  const [byId, setById] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Join the ids so the effect re-runs on a genuinely different list rather than on
  // every render that happens to rebuild the array.
  const key = trainerItemIds.join(',');

  useEffect(() => {
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) {
      setById(new Map());
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    monday
      .api(NAMES_QUERY, { ids })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setById(readNames(data));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, monday]);

  return { byId, loading, error };
}
