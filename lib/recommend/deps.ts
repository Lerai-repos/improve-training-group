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
import { createMemoryTravelCacheStore, createTravelCache } from './travel-cache';
import type { StatusWriter } from './delivery';
import { readRoster } from './roster';
import type { ServiceDeps } from './service';

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
    // In-process only: the cache is empty on every cold start, so a warm instance
    // saves Routes calls and a cold one simply pays for them. The KV-backed store
    // that makes it shared lands next pass.
    travelCache: createTravelCache(createMemoryTravelCacheStore()),
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
    inplannenGroupId: process.env.MONDAY_INPLANNEN_GROUP_ID ?? INPLANNEN_GROUP_ID,
    statusColumnId: RECOMMENDATION_STATUS_COLUMN,
    runLabel: RECOMMENDATION_STATUS_LABELS.run,
  };
}
