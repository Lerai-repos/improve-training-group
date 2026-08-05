import { createHash } from 'node:crypto';

import { parseAcknowledgements } from '@lib/monday';
import {
  AGENDA_2026_BOARD,
  ITEM_FIELDS,
  INPLANNEN_GROUP_ID,
  MONDAY_API_VERSION,
  RECOMMENDATION_STATUS_COLUMN,
  RECOMMENDATION_STATUS_LABELS,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

import ackJson from '../../docs/m2a/acknowledgements.json';
import { createAddressFormatter } from './address';
import { assertAddressHashKey } from './address-key';
import { canonicalJson } from './artifact';
import { currentDeadlineMs } from './deadline';
import { createOpenRouterCompletion } from './completion';
import { buildEngineConfig, newWorkerOwner } from './engine-config';
import type { WebhookRouting } from './event';
import { createMondayReader } from './monday-reader';
import { createMondayStatusWriter } from './monday-status';
import { createGoogleRoutesTransport, createRoutesProvider } from './travel';
import { createKvTravelCacheStore, createTravelCache } from './travel-cache';
import type { StatusWriter } from './delivery';
import { createAlertGate, type FailureCallbackDeps } from './failure-callback';
import { createRedisClient, createUpstashKvStore } from './kv';
import { createOutcomeStore, type OutcomeStore } from './outcome';
import { createQStashClient, createQStashPublisher, publicBaseUrl } from './qstash';
import { createRunQueue, type JobPublisher } from './queue';
import { createUpstashQueueStore, type QueueStore } from './queue-store';
import { readRoster } from './roster';
import type { ServiceDeps } from './service';
import type { RunQueue } from './webhook';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

const ACK_VERSION_LENGTH = 16;

// Static-import the acknowledgements so Vercel's file tracing bundles them into
// EVERY function that imports these deps (webhook + cron) — a runtime fs read is
// untraceable and silently fell back to empty decisions in one function but not
// the other, making results depend on which worker claimed the run.
// parseAcknowledgements throws on a malformed file → a bad deploy fails loudly.
/**
 * The reviewed conflict acknowledgements. EXPORTED because the readiness report has
 * to use the same ones: with EMPTY_ACK an acknowledged conflict stays unresolved
 * there, so the endpoint would report a trainer as not-green while the engine
 * happily recommends them.
 */
export const ACKNOWLEDGEMENTS = parseAcknowledgements(ackJson);
const ACK = ACKNOWLEDGEMENTS;
const ACK_VERSION = createHash('sha256')
  .update(canonicalJson(ackJson))
  .digest('hex')
  .slice(0, ACK_VERSION_LENGTH);

/** Everything a run needs: the compute ports plus the scoped Monday status writer. */
export interface EngineDeps extends ServiceDeps {
  statusWriter: StatusWriter;
  owner: string;
}

/**
 * The queue-side dependency graph, built WITHOUT the roster or any provider.
 *
 * The webhook and the sweep must stay cheap: they allocate a generation and hand the
 * work to QStash. Building the full engine there would cost a paginated trainers-board
 * read per webhook call, against a 25.000/day Monday budget, for work the job route
 * does anyway.
 */
function buildPublisher(): JobPublisher {
  const base = publicBaseUrl();
  return createQStashPublisher({
    client: createQStashClient(),
    jobUrl: `${base}/api/jobs/recommend`,
    failureUrl: `${base}/api/jobs/recommend/failed`,
  });
}

/**
 * Shared Redis-backed state. `createUpstashQueueStore` — the LUA implementation — is
 * mandatory here: `createQueueStore` does its transitions as read-modify-write in
 * TypeScript, which is correct only on a single-threaded in-memory store. Against a
 * shared Redis it would let two concurrent deliveries of one trigger both find no
 * record, both allocate a generation, and then have QStash publish only one of them —
 * so the surviving job sees a higher `gen` than its own and skips itself as
 * superseded. The training would silently never get an answer.
 */
function buildRedisState(): { store: QueueStore; outcomes: OutcomeStore } {
  const redis = createRedisClient();
  return {
    store: createUpstashQueueStore(redis),
    outcomes: createOutcomeStore(createUpstashKvStore(redis)),
  };
}

export function buildQueueDeps(): {
  store: QueueStore;
  publisher: JobPublisher;
  queue: RunQueue;
} {
  const { store } = buildRedisState();
  const publisher = buildPublisher();
  return { store, publisher, queue: createRunQueue(store, publisher) };
}

/** Queue state + the immutable outcome store, shared by the job and callback routes. */
export function buildJobStateDeps(): {
  store: QueueStore;
  outcomes: OutcomeStore;
  publisher: JobPublisher;
} {
  return { ...buildRedisState(), publisher: buildPublisher() };
}

/**
 * Deps for the failure callback. It needs the Monday writer but NOT the roster or any
 * provider: it never computes, it only delivers an outcome that already exists (or
 * records FOUT because none ever will).
 */
export function buildFailureCallbackDeps(): FailureCallbackDeps {
  const redis = createRedisClient();
  return {
    store: createUpstashQueueStore(redis),
    outcomes: createOutcomeStore(createUpstashKvStore(redis)),
    publisher: buildPublisher(),
    alerts: createAlertGate(createUpstashKvStore(redis)),
    writer: buildStatusWriter(),
  };
}

/** The scoped Monday status writer. No network at construction — safe to build eagerly. */
export function buildStatusWriter(): StatusWriter {
  return createMondayStatusWriter({
    token: requireEnv('MONDAY_API_TOKEN'),
    apiVersion: MONDAY_API_VERSION,
    boardId: AGENDA_2026_BOARD,
  });
}

/** Assemble the full dependency graph from env. The roster is read ONCE here. */
export async function buildWorkerDeps(): Promise<EngineDeps> {
  assertAddressHashKey(); // fail fast on a missing/short secret, not mid-run at the travel stage
  const token = requireEnv('MONDAY_API_TOKEN');
  // The live Monday reads run inside the worker's run deadline too — 5 × 30s attempts
  // plus an uncapped Retry-After would otherwise outlast the route on a Monday outage.
  const client = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: currentDeadlineMs,
  });
  return {
    reader: createMondayReader(client),
    roster: await readRoster(client, ITEM_FIELDS),
    addressFormatter: createAddressFormatter(
      createOpenRouterCompletion(requireEnv('OPENROUTER_API_KEY'))
    ),
    travelProvider: createRoutesProvider(
      createGoogleRoutesTransport(requireEnv('GOOGLE_MAPS_API_KEY'))
    ),
    // Shared across invocations now, so a cold start no longer re-pays for routes
    // another instance already looked up. Only keyed fingerprints and distances are
    // stored — never a raw address.
    travelCache: createTravelCache(createKvTravelCacheStore(createUpstashKvStore(createRedisClient()))),
    statusWriter: createMondayStatusWriter({
      token,
      apiVersion: MONDAY_API_VERSION,
      boardId: AGENDA_2026_BOARD,
    }),
    ack: ACK,
    config: buildEngineConfig({ ackVersion: ACK_VERSION }),
    owner: newWorkerOwner(),
  };
}

/** Webhook routing config (Inplannen group + status column + RUN label). */
export function webhookRouting(): WebhookRouting {
  return {
    // `||`, not `??`: a blank override must fall back, not win. `??` would let
    // `MONDAY_INPLANNEN_GROUP_ID=` produce an empty id that matches no group, so every
    // group-move trigger would be silently ignored with a perfectly healthy 200.
    inplannenGroupId: process.env.MONDAY_INPLANNEN_GROUP_ID || INPLANNEN_GROUP_ID,
    statusColumnId: RECOMMENDATION_STATUS_COLUMN,
    runLabel: RECOMMENDATION_STATUS_LABELS.run,
  };
}
