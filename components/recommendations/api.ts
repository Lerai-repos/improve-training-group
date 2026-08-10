'use client';

import type { MondayBridge } from './monday-client';
import type { ApiEnvelope, RecommendationView } from './types';

/**
 * Calls to our own backend, authenticated with the Monday session token.
 *
 * **A fresh token per call, and one retry on 401.** A token captured when the view
 * opened expires while the view stays open — a planner who leaves an item on screen over
 * lunch would come back to a list that silently stops refreshing. Monday mints tokens
 * cheaply, so the simple thing is also the correct one; the retry covers the case where
 * a token expires between being fetched and being used.
 */

export interface RecommendationsApi {
  get(itemId: string, signal?: AbortSignal): Promise<RecommendationView>;
  recalculate(itemId: string, actionId: string): Promise<void>;
  setApproached(
    itemId: string,
    input: { generation: number; trainerItemId: string; approached: boolean }
  ): Promise<void>;
}

/** An error carrying the HTTP status, so callers can tell 409 from 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const UNAUTHORIZED = 401;

export function createRecommendationsApi(monday: MondayBridge): RecommendationsApi {
  async function send(
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<ApiEnvelope<unknown>> {
    const attempt = async (): Promise<Response> => {
      const token = await monday.sessionToken();
      return await fetch(path, {
        ...init,
        signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    };

    let response = await attempt();
    if (response.status === UNAUTHORIZED) {
      // One retry with a freshly minted token. If it fails again the answer really is
      // "you may not", and retrying further would only turn a clear refusal into a hang.
      response = await attempt();
    }

    const body: ApiEnvelope<unknown> = await response.json().catch(() => ({
      success: false,
      error: 'the server sent something that was not JSON',
    }));

    if (!response.ok || !body.success) {
      throw new ApiError(response.status, body.error ?? `request failed (${response.status})`);
    }
    return body;
  }

  const base = (itemId: string): string => `/api/recommendations/${encodeURIComponent(itemId)}`;

  return {
    async get(itemId, signal) {
      const body = await send(base(itemId), { method: 'GET' }, signal);
      return asView(body.data);
    },

    async recalculate(itemId, actionId) {
      await send(`${base(itemId)}/recalculate`, {
        method: 'POST',
        body: JSON.stringify({ actionId }),
      });
    },

    async setApproached(itemId, input) {
      await send(`${base(itemId)}/approached`, { method: 'PUT', body: JSON.stringify(input) });
    },
  };
}

/**
 * Narrow the envelope's `unknown` payload without a cast.
 *
 * Only the discriminant is checked: the server owns this shape and validates what it
 * stores, so re-validating every field in the browser would duplicate the schema for no
 * benefit. What matters is not rendering `undefined.kind`.
 */
function asView(data: unknown): RecommendationView {
  if (
    typeof data === 'object' &&
    data !== null &&
    'state' in data &&
    typeof data.state === 'object' &&
    data.state !== null &&
    'kind' in data.state &&
    'caps' in data
  ) {
    const { state, caps } = data;
    if (isViewShape(state) && isCapsShape(caps)) {
      return { state, caps };
    }
  }
  throw new ApiError(0, 'the server sent an unrecognizable response');
}

function isViewShape(value: object): value is RecommendationView['state'] {
  return 'kind' in value && typeof value.kind === 'string';
}

function isCapsShape(value: unknown): value is RecommendationView['caps'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'canPlan' in value &&
    typeof value.canPlan === 'boolean' &&
    'canViewFull' in value &&
    typeof value.canViewFull === 'boolean'
  );
}
