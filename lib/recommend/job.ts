import { log } from '@lib/logger';

import { deliverOutcome } from './deliver';
import type { StatusLabel, StatusWriter } from './delivery';
import type { OutcomeClaim, OutcomeStore } from './outcome';
import type { JobPublisher, PublishedJob } from './queue';
import type { QueueStore } from './queue-store';
import type { RecommendationResult, Stage } from './service';

/**
 * One queued job: decide the answer once, deliver it, and tell the queue whether
 * trying again could ever help.
 *
 * That last part is the contract that keeps FOUT honest. A provider outage and an
 * unusable date both end as "FOUT" for the planner, but they must be treated in
 * opposite ways: the outage should be retried and must NOT be frozen into the
 * immutable outcome, while the bad date should be written once and never retried,
 * because no number of attempts will fix a blank field.
 */

export interface JobDeps {
  store: Pick<QueueStore, 'readGeneration' | 'recordJob'>;
  outcomes: OutcomeStore;
  publisher: JobPublisher;
  writer: StatusWriter;
  runRecommendation: (mondayItemId: string) => Promise<RecommendationResult>;
}

export type JobOutcome =
  /** A newer generation exists; its own job owns the board. */
  | { kind: 'superseded' }
  | { kind: 'delivered'; label: StatusLabel; repairPublished: boolean }
  /** Terminal: FOUT is recorded and written. The queue must stop retrying. */
  | { kind: 'terminal'; label: 'FOUT'; stage: Stage }
  /** Transient: nothing terminal recorded. The queue should try again. */
  | { kind: 'retry'; stage: Stage | 'delivery'; message: string | null };

/**
 * A completed run as the outcome store wants it. `GEEN MATCH` keeps an empty row list
 * rather than a null one: "we looked and found nobody" is an answer, and the view must
 * not present it as a missing computation.
 */
function toClaim(result: RecommendationResult): OutcomeClaim {
  if (!result.ok) {
    return { kind: 'failed', stage: result.failure.stage, message: result.failure.message };
  }
  return result.resultStatus === 'GEREED'
    ? {
        kind: 'ready',
        rows: result.rows,
        trainingMonth: result.trainingMonth,
        duurTraining: result.duurTraining,
      }
    : { kind: 'no_match' };
}

export async function runJob(deps: JobDeps, job: PublishedJob): Promise<JobOutcome> {
  const { mondayItemId, generation } = job;

  // Cheapest possible early-out, and one the Postgres design never had: it only
  // discovered supersession after computing. Here it costs a single GET and saves
  // both a full Monday read and the paid provider calls.
  const current = await deps.store.readGeneration(mondayItemId);
  if (current > generation) {
    log.debug('job: superseded before compute', { mondayItemId, generation, current });
    return { kind: 'superseded' };
  }

  const stored = await deps.outcomes.read(mondayItemId, generation);
  if (stored) {
    // A retry, a repair, or a DLQ replay. The answer for this generation is already
    // decided; recomputing could produce a different one from since-changed data.
    return deliver(deps, job, stored);
  }

  const result = await deps.runRecommendation(mondayItemId);

  if (!result.ok && result.failure.retryable) {
    log.warn('job: transient failure, leaving the generation undecided', {
      mondayItemId,
      generation,
      stage: result.failure.stage,
    });
    return { kind: 'retry', stage: result.failure.stage, message: result.failure.message };
  }

  // Label and rows are recorded together, so the board can never show an answer whose
  // list was lost: a crash between two writes would be unrepairable, because the early
  // return above short-circuits on the label and this code would never run again.
  const label = await deps.outcomes.claim(mondayItemId, generation, toClaim(result));
  const delivered = await deliver(deps, job, label);

  // The AUTHORITATIVE label decides this, not `result` — they can disagree. If another
  // execution won the claim race, we just delivered ITS answer, and reporting our own
  // failure would dead-letter a message whose write succeeded and fire a false alert.
  // Terminal therefore requires both: we failed terminally AND the recorded outcome is
  // the FOUT we tried to write.
  if (delivered.kind === 'delivered' && !result.ok && label === 'FOUT') {
    return { kind: 'terminal', label: 'FOUT', stage: result.failure.stage };
  }
  return delivered;
}

async function deliver(
  deps: JobDeps,
  job: PublishedJob,
  label: StatusLabel
): Promise<JobOutcome> {
  try {
    const result = await deliverOutcome(
      { queue: deps.store, writer: deps.writer, publisher: deps.publisher },
      {
        mondayItemId: job.mondayItemId,
        generation: job.generation,
        label,
        hop: job.hop,
      }
    );
    if (!result.delivered) {
      return { kind: 'superseded' };
    }
    return { kind: 'delivered', label, repairPublished: result.repairPublished };
  } catch (error) {
    // The answer is already recorded, so this is purely a delivery problem: retry
    // re-sends the SAME label rather than recomputing it.
    const message = error instanceof Error ? error.message : String(error);
    log.error('job: monday write failed', { mondayItemId: job.mondayItemId, message });
    return { kind: 'retry', stage: 'delivery', message };
  }
}
