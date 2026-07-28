import { z } from 'zod';

import { fetchWithRetry } from './http';
import type { OneWayLeg } from './travel-enrich';

/**
 * Google Routes API (`computeRouteMatrix`) travel provider. Distance Matrix is a
 * legacy API; Routes returns a per-element `condition` (ROUTE_EXISTS /
 * ROUTE_NOT_FOUND) plus a `status` — BOTH are in the field mask so a failed
 * element can't masquerade as a success. Failures are classified, never zeroed:
 * terminal (ROUTE_NOT_FOUND) vs transient (status error / transport). The caller
 * decides origin-aware policy (a shared HQ/destination failure fails the run; a
 * single trainer origin ROUTE_NOT_FOUND excludes that trainer).
 */

/** Per-origin outcome for one origin→destination pairing (one-way). */
export type RouteElement =
  | { status: 'ok'; leg: OneWayLeg }
  | { status: 'not_found' } // terminal — cache with a short negative TTL, exclude the trainer
  | { status: 'transient'; detail: string }; // retry; if it persists → FOUT, never cached

export interface TravelProvider {
  /** Stable key (provider + routing preference + version) — part of the cache key. */
  routingKey(): string;
  /** One-way legs, one per origin (in order), for a single destination. */
  distances(origins: readonly string[], destination: string): Promise<RouteElement[]>;
}

/** Low-level transport: POST one batch, return the parsed JSON (I/O only). */
export type RoutesTransport = (origins: readonly string[], destination: string) => Promise<unknown>;

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTING_PREFERENCE = 'TRAFFIC_UNAWARE';
const TRAVEL_MODE = 'DRIVE';
const FIELD_MASK = 'originIndex,destinationIndex,condition,distanceMeters,duration,status';
const ROUTING_KEY = `google-routes:${TRAVEL_MODE}:${ROUTING_PREFERENCE}:v1`;
// computeRouteMatrix with ADDRESS waypoints caps at 50 waypoints/request → at most
// 49 origins for a single destination. (Lat/lng waypoints allow far more, but we
// pass addresses.) Larger batches fail the whole request.
const MAX_ADDRESS_ORIGINS = 49;
const DEFAULT_BATCH_SIZE = MAX_ADDRESS_ORIGINS;
const METERS_PER_KM = 1000;
const SECONDS_PER_MINUTE = 60;
// A 200 whose body has missing elements / malformed JSON / an unexpected condition
// parses to `transient` — the HTTP layer can't see that, so retry the batch here.
const DEFAULT_BATCH_ATTEMPTS = 3;
const BATCH_BASE_DELAY_MS = 250;
const BACKOFF_BASE = 2;

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const elementSchema = z.object({
  originIndex: z.number().optional(),
  destinationIndex: z.number().optional(),
  condition: z.string().optional(),
  distanceMeters: z.number().optional(),
  duration: z.union([z.string(), z.number()]).optional(),
  status: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
});
const responseSchema = z.array(elementSchema);

// Protobuf `Duration` JSON: digits, optional fractional part, mandatory trailing
// 's' (e.g. "123s", "1.5s"). Anything else ("600ms", "600garbage", "") is invalid.
const PROTOBUF_DURATION = /^\d+(\.\d+)?s$/;

/**
 * Parse a Routes `duration` (protobuf-duration string or a number of seconds) to a
 * non-negative finite number of seconds. Returns null for anything else — a
 * missing/malformed/negative duration must NOT be treated as 0 (which would
 * fabricate a free leg). `parseFloat` is deliberately NOT used: it would accept
 * "600ms"/"600garbage" as 600.
 */
function durationSeconds(d: string | number | undefined): number | null {
  if (typeof d === 'number') {
    return Number.isFinite(d) && d >= 0 ? d : null;
  }
  if (typeof d === 'string') {
    if (!PROTOBUF_DURATION.test(d)) {
      return null;
    }
    const secs = Number.parseFloat(d.slice(0, -1));
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }
  return null;
}

function classify(el: z.infer<typeof elementSchema>): RouteElement {
  if (el.status && el.status.code !== undefined && el.status.code !== 0) {
    return { status: 'transient', detail: el.status.message ?? `status ${el.status.code}` };
  }
  if (el.condition === 'ROUTE_EXISTS') {
    // A ROUTE_EXISTS element with missing/invalid metrics must be retried, never
    // returned as a zero-distance/zero-duration "success" (the silent €0-travel
    // failure the pipeline is built to prevent). Two distinct physical addresses
    // always yield positive metrics, so absent/malformed values mean a bad element.
    const meters = el.distanceMeters;
    const secs = durationSeconds(el.duration);
    if (meters === undefined || !Number.isFinite(meters) || meters < 0 || secs === null) {
      return { status: 'transient', detail: 'ROUTE_EXISTS with missing/invalid metrics' };
    }
    return {
      status: 'ok',
      leg: {
        distanceKm: meters / METERS_PER_KM,
        durationMinutes: secs / SECONDS_PER_MINUTE,
      },
    };
  }
  if (el.condition === 'ROUTE_NOT_FOUND') {
    return { status: 'not_found' };
  }
  return { status: 'transient', detail: `unexpected condition ${el.condition ?? 'none'}` };
}

/**
 * Map a raw computeRouteMatrix response (an array of elements) to one
 * {@link RouteElement} per origin, in order. An unparseable response or a missing
 * element for an origin is `transient` (retryable), never a silent success/zero.
 */
export function parseRouteMatrixResponse(json: unknown, originCount: number): RouteElement[] {
  const out: RouteElement[] = Array.from({ length: originCount }, () => ({
    status: 'transient',
    detail: 'missing element',
  }));
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    return Array.from({ length: originCount }, () => ({
      status: 'transient',
      detail: 'unparseable routes response',
    }));
  }
  for (const el of parsed.data) {
    const idx = el.originIndex ?? 0;
    if (idx >= 0 && idx < originCount) {
      out[idx] = classify(el);
    }
  }
  return out;
}

/** Build a provider over an injected transport (batches origins, parses each batch). */
/**
 * One batch → elements. Retries ONLY when a SUCCESSFUL transport call parsed into
 * transient elements (a 200 with missing/malformed elements). A transport throw is
 * an HTTP-level failure the transport already retried (fetchWithRetry owns those) —
 * retrying it here would multiply requests (3 × 3), so it returns immediately.
 */
async function resolveBatch(
  transport: RoutesTransport,
  batch: readonly string[],
  destination: string,
  attempts: number
): Promise<RouteElement[]> {
  let elements: RouteElement[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let json: unknown;
    try {
      json = await transport(batch, destination);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return batch.map(() => ({ status: 'transient', detail }));
    }
    elements = parseRouteMatrixResponse(json, batch.length);
    const anyTransient = elements.some((el) => el.status === 'transient');
    if (attempt === attempts - 1 || !anyTransient) {
      return elements;
    }
    await delay(BATCH_BASE_DELAY_MS * BACKOFF_BASE ** attempt);
  }
  return elements;
}

export function createRoutesProvider(
  transport: RoutesTransport,
  opts?: { batchSize?: number; batchAttempts?: number }
): TravelProvider {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchAttempts = opts?.batchAttempts ?? DEFAULT_BATCH_ATTEMPTS;
  if (batchSize < 1 || batchSize > MAX_ADDRESS_ORIGINS) {
    throw new Error(
      `createRoutesProvider: batchSize ${batchSize} must be 1..${MAX_ADDRESS_ORIGINS} (address-waypoint cap)`
    );
  }
  return {
    routingKey: () => ROUTING_KEY,
    async distances(origins: readonly string[], destination: string): Promise<RouteElement[]> {
      const out: RouteElement[] = [];
      for (let i = 0; i < origins.length; i += batchSize) {
        const batch = origins.slice(i, i + batchSize);
        out.push(...(await resolveBatch(transport, batch, destination, batchAttempts)));
      }
      return out;
    },
  };
}

/** The real Google transport (fetch). Not unit-tested; exercised live in Phase 6. */
export function createGoogleRoutesTransport(apiKey: string): RoutesTransport {
  return async (origins: readonly string[], destination: string): Promise<unknown> => {
    const res = await fetchWithRetry(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        origins: origins.map((address) => ({ waypoint: { address } })),
        destinations: [{ waypoint: { address: destination } }],
        travelMode: TRAVEL_MODE,
        routingPreference: ROUTING_PREFERENCE,
      }),
    });
    if (!res.ok) {
      throw new Error(`Routes HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };
}

/** A deterministic provider for tests / orchestration stubs. */
export function createStubTravelProvider(
  fn: (origin: string, destination: string) => RouteElement,
  routingKey = 'stub:v1'
): TravelProvider {
  return {
    routingKey: () => routingKey,
    distances(origins: readonly string[], destination: string): Promise<RouteElement[]> {
      return Promise.resolve(origins.map((o) => fn(o, destination)));
    },
  };
}
