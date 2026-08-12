'use client';

import { useEffect, useState } from 'react';

import { TRAINER_COLUMNS } from '@lib/monday/board-config';

import type { MondayBridge } from './monday-client';

/**
 * Trainer names **and phone numbers**, resolved in the browser.
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
 *
 * The phone number rides along in the SAME query — it is needed only for the WhatsApp
 * link, on exactly the trainers already being named, and a second round trip for one
 * column would double the per-view cost for nothing. It is subject to the same rule as
 * the names: read live, never stored.
 *
 * **Only when the caller can plan.** A view-only caller renders no WhatsApp control, so
 * fetching their trainers' phone numbers would pull personal data into a browser that has
 * no use for it — beyond the capability the feature was scoped to, and exactly the kind of
 * quiet widening this codebase keeps out of the stored rows.
 */

const NAMES_QUERY = `
query ($ids: [ID!], $cols: [String!]) {
  items(ids: $ids) {
    id
    name
    column_values(ids: $cols) { id text }
  }
}`;

/** Names only — no `column_values`, so no phone number leaves Monday at all. */
const NAMES_ONLY_QUERY = `query ($ids: [ID!]) { items(ids: $ids) { id name } }`;

/**
 * Pull `{ id, name }` pairs out of whatever came back.
 *
 * Written as a walk over `unknown` rather than a cast: this is the one response shaped
 * by Monday rather than by us, and a query that partially failed still returns a
 * well-formed envelope with pieces missing.
 */
function readNames(data: unknown): { names: Map<string, string>; phones: Map<string, string> } {
  const names = new Map<string, string>();
  const phones = new Map<string, string>();
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    return { names, phones };
  }
  const { items } = data;
  if (!Array.isArray(items)) {
    return { names, phones };
  }
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('name' in item)) {
      continue;
    }
    const { id, name } = item;
    if (!(typeof id === 'string' || typeof id === 'number') || typeof name !== 'string') {
      continue;
    }
    names.set(String(id), name);

    // A trainer with no phone number on the board is ordinary — the link is simply not
    // offered for them, which is why this is a separate map rather than a nullable field.
    if (!('column_values' in item) || !Array.isArray(item.column_values)) {
      continue;
    }
    for (const column of item.column_values) {
      if (typeof column !== 'object' || column === null || !('text' in column)) {
        continue;
      }
      if (typeof column.text === 'string' && column.text.trim() !== '') {
        phones.set(String(id), column.text);
      }
    }
  }
  return { names, phones };
}

export interface TrainerNames {
  byId: ReadonlyMap<string, string>;
  /** Only trainers who have one on the board; used for the WhatsApp link. */
  phoneById: ReadonlyMap<string, string>;
  loading: boolean;
  /** Set when the lookup failed; the table shows ids and says why. */
  error: string | null;
}

export function useTrainerNames(
  monday: MondayBridge,
  trainerItemIds: string[],
  /** Pass `canPlan`. Phone numbers are fetched only for callers who can message. */
  options: { includePhones?: boolean } = {}
): TrainerNames {
  const includePhones = options.includePhones === true;
  const [byId, setById] = useState<ReadonlyMap<string, string>>(new Map());
  const [phoneById, setPhoneById] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Join the ids so the effect re-runs on a genuinely different list rather than on
  // every render that happens to rebuild the array.
  const key = trainerItemIds.join(',');

  useEffect(() => {
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) {
      setById(new Map());
      setPhoneById(new Map());
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    monday
      .api(
        includePhones ? NAMES_QUERY : NAMES_ONLY_QUERY,
        includePhones ? { ids, cols: [TRAINER_COLUMNS.telefoon] } : { ids }
      )
      .then((data) => {
        if (cancelled) {
          return;
        }
        const { names, phones } = readNames(data);
        setById(names);
        setPhoneById(phones);
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
    // `includePhones` is a dependency: capabilities arrive after the first render, so a
    // planner's first pass runs without it and must re-query once it is known.
  }, [includePhones, key, monday]);

  return { byId, phoneById, loading, error };
}
