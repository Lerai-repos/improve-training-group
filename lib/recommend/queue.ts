import { log } from '@lib/logger';

import type { QueueStore, TriggerRecord } from './queue-store';
import type { EnqueueResult, RunQueue } from './webhook';

/**
 * The queue: turn an authentic Monday trigger into exactly one durably-queued job,
 * and recover the ones whose publication failed.
 *
 * The ordering here is the whole point. The record is created (with its generation,
 * and indexed for recovery) BEFORE anything is published, and is only marked
 * published — and only then given a dedup TTL — once the job is genuinely queued. A
 * design that recorded "seen" first turned Monday's own retry into a no-op and lost
 * the trigger for good.
 */

/** What the job route receives. */
export interface PublishedJob {
  triggerUuid: string;
  mondayItemId: string;
  generation: number;
  /** Repair depth, absent for a job that came straight from a Monday trigger. */
  hop?: number;
}

/** The transport that durably holds the job (QStash in production). */
export interface JobPublisher {
  publish(job: PublishedJob): Promise<void>;
}

/** Attempts before the sweep starts shouting. It never stops retrying. */
export const ALERT_AFTER_ATTEMPTS = 5;

/** Backoff ceiling, and the interval used forever after the alert threshold. */
export const LONG_RETRY_INTERVAL_MS = 15 * 60 * 1000;

const BASE_RETRY_INTERVAL_MS = 60 * 1000;

/** Exponential up to the ceiling, then flat — never parked, never spinning. */
export function retryDelayMs(attempts: number): number {
  const exponential = BASE_RETRY_INTERVAL_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, LONG_RETRY_INTERVAL_MS);
}

export function createRunQueue(
  store: QueueStore,
  publisher: JobPublisher,
  nowMs: () => number = Date.now
): RunQueue {
  return {
    async enqueue({ triggerUuid, mondayItemId }): Promise<EnqueueResult> {
      const { record } = await store.enqueueOrGet({
        triggerUuid,
        mondayItemId,
        nowMs: nowMs(),
      });

      // Already durably queued — this is Monday redelivering, not new work.
      if (record.status === 'published') {
        return { accepted: false, reason: 'duplicate' };
      }

      // A throw here is deliberate: the route returns non-2xx, Monday retries, and
      // the record is still pending and indexed, so the retry RESUMES publication
      // with the same generation rather than allocating a new one.
      await publisher.publish({
        triggerUuid,
        mondayItemId,
        generation: record.generation,
      });

      await store.markPublished(triggerUuid);
      return { accepted: true, generation: record.generation };
    },
  };
}

export interface SweepDeps {
  store: QueueStore;
  publisher: JobPublisher;
  nowMs: () => number;
  /** Bound on records handled per run, so the cron stays inside its budget. */
  limit?: number;
}

export interface SweepResult {
  republished: number;
  orphansRemoved: number;
  failed: number;
  alerted: number;
}

const DEFAULT_SWEEP_LIMIT = 50;

/**
 * Recover triggers whose publication never landed. This is what makes a job durable
 * BEYOND Monday's 30-minute retry horizon: without it, a QStash outage outlasting
 * that horizon would strand the trigger, and — worse — a generation allocated but
 * never queued blocks every older generation from writing, leaving the training with
 * no answer at all.
 */
export async function sweepPending(deps: SweepDeps): Promise<SweepResult> {
  const { store, publisher, nowMs, limit = DEFAULT_SWEEP_LIMIT } = deps;
  const result: SweepResult = { republished: 0, orphansRemoved: 0, failed: 0, alerted: 0 };

  for (const triggerUuid of await store.dueTriggers(nowMs(), limit)) {
    const record = await store.readTrigger(triggerUuid);

    // Index entry with no live record, or one already published: nothing to resume.
    if (!record || record.status === 'published') {
      await store.removePending(triggerUuid);
      result.orphansRemoved += 1;
      continue;
    }

    // Reschedule BEFORE publishing. If the publish throws, the entry is already
    // pushed into the future, so the next sweep can't spin on it.
    const bumped = await store.bumpAttempt(triggerUuid, nowMs() + retryDelayMs(record.attempts + 1));
    if (!bumped) {
      continue; // raced with the webhook's markPublished — it won, nothing to do
    }

    if (bumped.attempts >= ALERT_AFTER_ATTEMPTS) {
      // Escalate, but keep retrying: a cap would make a long outage need a human.
      log.error('recommendation trigger still unpublished', {
        triggerUuid,
        mondayItemId: bumped.mondayItemId,
        generation: bumped.generation,
        attempts: bumped.attempts,
      });
      result.alerted += 1;
    }

    if (await publishQuietly(publisher, bumped)) {
      await store.markPublished(triggerUuid);
      result.republished += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}

async function publishQuietly(publisher: JobPublisher, record: TriggerRecord): Promise<boolean> {
  try {
    await publisher.publish({
      triggerUuid: record.triggerUuid,
      mondayItemId: record.mondayItemId,
      generation: record.generation,
      // Carried through: dropping it would republish a recovered repair as a fresh
      // hop 0, restarting the chain and slipping past MAX_REPAIR_HOPS.
      hop: record.hop,
    });
    return true;
  } catch (error) {
    // One stuck trigger must not abort the sweep for the others.
    log.warn('sweep: republish failed', {
      triggerUuid: record.triggerUuid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
