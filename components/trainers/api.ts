'use client';

import type { TrainerOverviewPayload } from '@lib/evaluations';
import type { MondayBoardBridge } from '@components/recommendations/monday-client';

/**
 * The one call this tab makes to our backend, authenticated with the Monday session
 * token.
 *
 * A fresh token per call and one retry on 401, for the same reason the recommendations
 * tab does it: a token captured when the view opened expires while the view stays open,
 * and a board view is exactly the kind of tab someone leaves sitting there.
 */

export class TrainerOverviewApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'TrainerOverviewApiError';
  }
}

const UNAUTHORIZED = 401;

export interface TrainerOverviewApi {
  get(signal?: AbortSignal): Promise<TrainerOverviewPayload>;
}

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Narrow the payload without a cast.
 *
 * Only the shape the table branches on: the server owns this DTO and validates what it
 * stores, so re-checking every field in the browser would duplicate the schema. What
 * matters is not calling `.map` on `undefined`.
 */
function asPayload(data: unknown): TrainerOverviewPayload {
  if (
    typeof data === 'object' &&
    data !== null &&
    'trainers' in data &&
    Array.isArray(data.trainers) &&
    'stale' in data &&
    typeof data.stale === 'boolean' &&
    'writtenAt' in data &&
    (typeof data.writtenAt === 'string' || data.writtenAt === null)
  ) {
    return { trainers: data.trainers, stale: data.stale, writtenAt: data.writtenAt };
  }
  throw new TrainerOverviewApiError(0, 'de server stuurde iets onherkenbaars terug');
}

export function createTrainerOverviewApi(monday: MondayBoardBridge): TrainerOverviewApi {
  return {
    async get(signal) {
      const attempt = async (): Promise<Response> => {
        const token = await monday.sessionToken();
        return await fetch('/api/trainers/overview', {
          method: 'GET',
          signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
      };

      let response = await attempt();
      if (response.status === UNAUTHORIZED) {
        // One retry with a freshly minted token. A second refusal really means "you may
        // not", and retrying further turns a clear answer into a hang.
        response = await attempt();
      }

      const body: Envelope = await response.json().catch(() => ({
        success: false,
        error: 'de server stuurde geen JSON terug',
      }));

      if (!response.ok || !body.success) {
        throw new TrainerOverviewApiError(
          response.status,
          body.error ?? `verzoek mislukt (${response.status})`
        );
      }
      return asPayload(body.data);
    },
  };
}
