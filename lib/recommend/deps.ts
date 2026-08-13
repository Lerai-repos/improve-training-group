import { createHash } from 'node:crypto';

import { parseAcknowledgements } from '@lib/monday';
import {
  AGENDA_2026_COLUMNS,
  agendaBoardId,
  ITEM_FIELDS,
  MONDAY_API_VERSION,
  RECOMMENDATION_STATUS_COLUMN,
  RECOMMENDATION_STATUS_LABELS,
  triggerGroupIds,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createSettingsLoader, provenanceOf } from '@lib/settings';
import type { SettingsProvenance } from '@lib/settings';
import { isProductionEnvironment } from '@lib/constants';

import ackJson from '../../docs/m2a/acknowledgements.json';
import { createAddressFormatter } from './address';
import { assertAddressHashKey } from './address-key';
import { createApproachedStore } from './approached';
import { readAgendaScan } from './assignments';
import { createCachedAssignments } from './assignment-cache';
import { capabilityPolicyFromEnv } from './capabilities';
import { createItemBoardReader, type ItemBoardReader } from './item-board';
import type { ViewDeps } from './recommendation-view';
import type { ApproachedDeps, RecalculateDeps } from './recommendation-actions';
import { sessionTokenConfigFromEnv } from './session-token';
import type { AuthDeps } from './view-auth';
import { canonicalJson } from './artifact';
import { currentDeadlineMs } from './deadline';
import { createOpenRouterCompletion } from './completion';
import { buildEngineConfig, newWorkerOwner } from './engine-config';
import type { WebhookRouting } from './event';
import { createMondayReader } from './monday-reader';
import { createMondayStatusWriter } from './monday-status';
import { createGoogleRoutesTransport, createRoutesProvider } from './travel';
import { createKvTravelCacheStore, createTravelCache } from './travel-cache';
import { createCityStore } from './city-store';
import type { StatusWriter } from './delivery';
import { createAlertGate, type FailureCallbackDeps } from './failure-callback';
import { createRedisClient, createUpstashKvStore } from './kv';
import { createUpstashOutcomeStore, type OutcomeStore } from './outcome';
import { createWhatsappTrainingReader, type WhatsappDeps } from './whatsapp-service';
import { createUpstashWhatsappStore } from './whatsapp-store';
import { createQStashClient, createQStashPublisher, publicBaseUrl } from './qstash';
import { createRunQueue, type JobPublisher } from './queue';
import { createUpstashQueueStore, type QueueStore } from './queue-store';
import { readRoster } from './roster';
import { readQualObservations } from './qualifications';
import { evalStatsEnabled, readEvalStats } from './eval-stats';

import {
  createOAuthGoogleAuth,
  createStatsStore,
  evaluationDocuments,
  googleSheetsSource,
  oauthCredentialsFromEnv,
  readAgendaHistory,
  type NightlyDeps,
} from '@lib/evaluations';
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

/**
 * How long a workload scan may take before the view gives up on it and renders `—`.
 *
 * Deliberately short: the list itself comes from Redis in milliseconds, and two extra
 * columns are not worth making a planner wait.
 */
const WORKLOAD_DEADLINE_MS = 6_000;

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
    outcomes: createUpstashOutcomeStore(redis),
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
    outcomes: createUpstashOutcomeStore(redis),
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
    boardId: agendaBoardId(),
  });
}

/** Assemble the full dependency graph from env. The roster is read ONCE here. */
/**
 * Everything the nightly evaluation job needs.
 *
 * Lives here rather than in `lib/evaluations` because it is the only place allowed to
 * wire both sides together: `lib/evaluations` may not import `@lib/recommend` (the
 * engine adapter imports it, so the reverse edge would close a cycle), and the
 * qualification reader lives on the recommend side.
 */
export function buildEvalStatsDeps(): NightlyDeps {
  const client = createMondayGraphQLClient({
    token: requireEnv('MONDAY_API_TOKEN'),
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: currentDeadlineMs,
  });
  return {
    // The ambient run deadline reaches Google too: `runWithDeadline` only makes the
    // budget available, so a fetch that never consults it would happily outlive the
    // route and rob it of its controlled failure.
    source: googleSheetsSource(
      createOAuthGoogleAuth(oauthCredentialsFromEnv(), fetch, currentDeadlineMs),
      evaluationDocuments(),
      fetch,
      currentDeadlineMs
    ),
    readHistory: () => readAgendaHistory(client),
    readQualifications: () => readQualObservations(client),
    store: createStatsStore(createUpstashKvStore(createRedisClient())),
    now: () => new Date(),
  };
}

/**
 * Returns the provenance ALONGSIDE the deps, rather than hiding it inside them.
 *
 * The job needs to record which settings produced an outcome, and this is the only
 * place that knows. Returning a pair also gets the failure case right for free: when
 * the settings read is what failed, this throws and there is no provenance to record —
 * which is exactly why a `failed` outcome may carry none.
 */
export async function buildWorkerDeps(): Promise<{
  deps: EngineDeps;
  settings: SettingsProvenance;
}> {
  assertAddressHashKey(); // fail fast on a missing/short secret, not mid-run at the travel stage
  const token = requireEnv('MONDAY_API_TOKEN');
  // The live Monday reads run inside the worker's run deadline too — 5 × 30s attempts
  // plus an uncapped Retry-After would otherwise outlast the route on a Monday outage.
  const client = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: currentDeadlineMs,
  });
  /**
   * Read once per execution, beside the roster, and only when the release gate is on.
   * `[]` while it is off means the engine behaves exactly as before — scores stay
   * (null, 0) and ranking falls back to cost then travel — so deploying this changes
   * nothing until the ranking diff has been approved.
   */
  const evaluations = evalStatsEnabled()
    ? await readEvalStats(createUpstashKvStore(createRedisClient()))
    : null;
  /**
   * Read BEFORE the engine is entered, and awaited here so a failure escapes
   * `buildWorkerDeps` rather than being observed mid-run. That is what makes the
   * snapshot a value rather than a port: there is no code path where the engine sees a
   * broken settings read and quietly prices from `CONFIG_DEFAULTS`. A persistent
   * failure exhausts QStash and lands as a terminal FOUT on the board — loud, and
   * distinguishable from a run the engine diagnosed itself.
   */
  const settings = await createSettingsLoader({
    client,
    kv: createUpstashKvStore(createRedisClient()),
    isProduction: isProductionEnvironment,
  }).read();
  return {
    settings: provenanceOf(settings),
    deps: {
    reader: createMondayReader(client),
    roster: await readRoster(client, ITEM_FIELDS),
    evaluations,
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
    // The town the address step resolved, kept for the WhatsApp message to read later.
    // Best-effort on both sides: nothing in a run depends on it.
    cityStore: createCityStore(createUpstashKvStore(createRedisClient())),
    statusWriter: createMondayStatusWriter({
      token,
      apiVersion: MONDAY_API_VERSION,
      boardId: agendaBoardId(),
    }),
    ack: ACK,
    config: buildEngineConfig({ settings, ackVersion: ACK_VERSION }),
    owner: newWorkerOwner(),
    },
  };
}

/**
 * Deps for the item view's three routes.
 *
 * Deliberately cheap: no roster, no providers, no address formatter. Opening the view
 * reads Redis and — for the mutating routes only — one Monday id lookup. Building the
 * engine here would put a paginated trainers-board read behind every page open.
 */
export function buildViewDeps(): {
  auth: AuthDeps;
  /** Redis only. Everything a `GET` needs, and nothing it does not. */
  view: ViewDeps;
  /**
   * FUNCTIONS, deliberately — the mutating routes need configuration that reading does
   * not, and building it eagerly made every `GET` depend on all of it.
   *
   * `recalculate` needs `PUBLIC_BASE_URL` for the QStash callbacks. BOTH need
   * `MONDAY_API_TOKEN` for the board check, which is the sharper one: the stored list is
   * served entirely from Redis, so a missing or rotated Monday token has no business
   * taking the view down. It should stop new work being queued, not stop planners
   * reading a list that is already computed.
   */
  recalculate: () => RecalculateDeps;
  approached: () => ApproachedDeps;
  whatsapp: () => WhatsappDeps;
} {
  const redis = createRedisClient();
  const kv = createUpstashKvStore(redis);
  const store = createUpstashQueueStore(redis);
  const outcomes = createUpstashOutcomeStore(redis);
  const approached = createApproachedStore(kv);
  const board = agendaBoardId();

  const boards = (): ItemBoardReader =>
    createItemBoardReader(
      createMondayGraphQLClient({
        token: requireEnv('MONDAY_API_TOKEN'),
        apiVersion: MONDAY_API_VERSION,
        deadlineMs: currentDeadlineMs,
      })
    );

  return {
    auth: { session: sessionTokenConfigFromEnv(), policy: capabilityPolicyFromEnv() },
    view: {
      queue: store,
      outcomes,
      approached,
      /**
       * Lazy Monday client on purpose: the workload scan is the ONLY part of a read that
       * touches Monday, and it degrades to `—` rather than failing the view. Building the
       * client eagerly would put a missing token back on the critical read path.
       */
      assignments: createCachedAssignments({
        kv,
        boardId: board,
        load: () => {
          /**
           * Captured ONCE, here — not recomputed per check.
           *
           * `deadlineMs` is a callback the client consults on every attempt, so
           * `() => Date.now() + 6_000` grants a fresh six seconds each time and an
           * outage burns the full retry budget instead of degrading. An absolute
           * timestamp is a deadline; a relative one is a renewal.
           */
          const deadline = Date.now() + WORKLOAD_DEADLINE_MS;
          return readAgendaScan(
            createMondayGraphQLClient({
              token: requireEnv('MONDAY_API_TOKEN'),
              apiVersion: MONDAY_API_VERSION,
              /**
               * Its OWN short deadline, not the worker's.
               *
               * `currentDeadlineMs` is null outside a run context, and the client then
               * spends five 30-second attempts before giving up — so during a Monday
               * outage the whole GET would time out long before `resolveWorkload` could
               * degrade to dashes. Workload is the one part of a read that is allowed to
               * be missing; it must fail fast enough for that to mean anything.
               */
              deadlineMs: () => deadline,
            }),
            {
              boardId: board,
              dateColumnId: AGENDA_2026_COLUMNS.datum,
              trainerColumnId: AGENDA_2026_COLUMNS.trainerRelation,
            }
          );
        },
      }),
    },
    recalculate: () => ({
      queue: createRunQueue(store, buildPublisher()),
      boards: boards(),
      agendaBoardId: board,
    }),
    approached: () => ({
      queue: store,
      outcomes,
      approached,
      boards: boards(),
      agendaBoardId: board,
    }),
    /**
     * Lazy for the same reason as the two above: this one needs `MONDAY_API_TOKEN`, and
     * a missing token has no business breaking a read that is served from Redis.
     */
    whatsapp: (): WhatsappDeps => ({
      reader: createWhatsappTrainingReader(
        createMondayGraphQLClient({
          token: requireEnv('MONDAY_API_TOKEN'),
          apiVersion: MONDAY_API_VERSION,
          deadlineMs: currentDeadlineMs,
        })
      ),
      store: createUpstashWhatsappStore(redis),
      cities: createCityStore(kv),
      boards: boards(),
      kv,
      boardId: board,
    }),
  };
}

/** Webhook routing config (trigger groups + status column + RUN label). */
export function webhookRouting(): WebhookRouting {
  return {
    inplannenGroupIds: triggerGroupIds(),
    // Unused in practice today: we register only the group-move webhook, so no column
    // event ever reaches us. Manual re-run belongs in the recommendations view, where
    // a button can call our API directly — no label, no automation, no second webhook.
    // Kept pointing at the legacy column so the parser's loop guard stays meaningful
    // if we ever do subscribe to a column again.
    statusColumnId: RECOMMENDATION_STATUS_COLUMN,
    runLabel: RECOMMENDATION_STATUS_LABELS.run,
  };
}
