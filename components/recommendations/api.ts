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

export interface SavedWhatsapp {
  edited: string;
  base: string;
}

export interface WhatsappPayload {
  generated: string;
  saved: SavedWhatsapp | null;
  /** Opaque concurrency token. Echo it back on every write; never interpret it. */
  token: string;
  /** Something IS stored and could not be read — not the same as nothing stored. */
  unreadable: boolean;
  warnings: string[];
}

export interface WhatsappWriteResult {
  saved: SavedWhatsapp | null;
  token: string;
}

/**
 * Split out from {@link RecommendationsApi} so the panel can be tested against a fake
 * that implements three methods rather than the whole surface.
 */
export interface WhatsappApi {
  getWhatsapp(itemId: string): Promise<WhatsappPayload>;
  saveWhatsapp(
    itemId: string,
    input: { edited: string; base: string; token: string },
    /**
     * `keepalive` lets the request outlive the document, for the last-gasp save when
     * Monday hides or replaces the iframe. Best-effort, never a guarantee — the token
     * fetch in front of it can still lose the race.
     */
    options?: { keepalive?: boolean }
  ): Promise<WhatsappWriteResult>;
  discardWhatsapp(
    itemId: string,
    token: string,
    options?: { keepalive?: boolean }
  ): Promise<WhatsappWriteResult>;
}

export interface RecommendationsApi extends WhatsappApi {
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

    async getWhatsapp(itemId) {
      const body = await send(`${base(itemId)}/whatsapp`, { method: 'GET' });
      return asWhatsapp(body.data);
    },

    async saveWhatsapp(itemId, input, options) {
      const body = await send(`${base(itemId)}/whatsapp`, {
        method: 'PUT',
        body: JSON.stringify(input),
        keepalive: options?.keepalive,
      });
      return asWrite(body.data);
    },

    async discardWhatsapp(itemId, token, options) {
      const body = await send(`${base(itemId)}/whatsapp`, {
        method: 'DELETE',
        body: JSON.stringify({ token }),
        keepalive: options?.keepalive,
      });
      return asWrite(body.data);
    },
  };
}

/** As with `asView`: check the shape we branch on, not every field. */
function asWhatsapp(data: unknown): WhatsappPayload {
  if (
    typeof data === 'object' &&
    data !== null &&
    'generated' in data &&
    typeof data.generated === 'string' &&
    'token' in data &&
    typeof data.token === 'string'
  ) {
    const warnings = 'warnings' in data && Array.isArray(data.warnings) ? data.warnings : [];
    return {
      generated: data.generated,
      token: data.token,
      saved: 'saved' in data ? asSaved(data.saved) : null,
      unreadable: 'unreadable' in data && data.unreadable === true,
      warnings: warnings.filter((w): w is string => typeof w === 'string'),
    };
  }
  throw new ApiError(0, 'the server sent an unrecognizable message');
}

function asWrite(data: unknown): WhatsappWriteResult {
  if (typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string') {
    return { token: data.token, saved: 'saved' in data ? asSaved(data.saved) : null };
  }
  throw new ApiError(0, 'the server sent an unrecognizable message');
}

function asSaved(value: unknown): SavedWhatsapp | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'edited' in value &&
    typeof value.edited === 'string' &&
    'base' in value &&
    typeof value.base === 'string'
  ) {
    return { edited: value.edited, base: value.base };
  }
  return null;
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
