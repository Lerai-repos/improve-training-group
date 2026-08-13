import { log } from '@lib/logger';

import { deliverOutcome } from './deliver';
import type { StatusLabel, StatusWriter } from './delivery';
import type { KvStore } from './kv';
import type { OutcomeStore } from './outcome';
import type { JobPublisher } from './queue';
import type { QueueStore } from './queue-store';

/**
 * What happens after QStash gives up: retries exhausted, or a terminal 489.
 *
 * Without this route a training whose newest generation failed would keep showing the
 * PREVIOUS generation's `GEREED` — stale, plausible, and wrong.
 *
 * The obvious implementation is also wrong: writing FOUT unconditionally. A job can
 * compute `GEREED` and then fail only at the Monday write, and replacing that answer
 * with an error would both mislead the planner and contradict the immutable outcome
 * already recorded for the generation. So the outcome decides, not the failure.
 */

export interface AlertGate {
  /** True the first time this DLQ id is seen. Callback delivery is itself retryable. */
  shouldAlert(dlqId: string): Promise<boolean>;
}

export function createAlertGate(kv: KvStore): AlertGate {
  const ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  return {
    shouldAlert: (dlqId) => kv.setIfAbsent(`alert:${dlqId}`, '1', { ttlMs: ALERT_TTL_MS }),
  };
}

export interface FailureCallbackDeps {
  store: Pick<QueueStore, 'readGeneration' | 'recordJob'>;
  outcomes: OutcomeStore;
  alerts: AlertGate;
  publisher: JobPublisher;
  writer: StatusWriter;
}

export interface FailureCallbackInput {
  mondayItemId: string;
  generation: number;
  dlqId: string;
}

export type FailureCallbackResult =
  | { kind: 'superseded'; alerted: boolean }
  | { kind: 'delivered'; label: StatusLabel; alerted: boolean }
  | { kind: 'undeliverable'; label: StatusLabel; alerted: boolean; message: string };

export async function handleFailureCallback(
  deps: FailureCallbackDeps,
  input: FailureCallbackInput
): Promise<FailureCallbackResult> {
  const { mondayItemId, generation, dlqId } = input;

  const current = await deps.store.readGeneration(mondayItemId);
  if (current > generation) {
    // A newer generation is already answering for this training. Writing anything
    // here would put a known-stale label on the board.
    log.debug('failure callback: superseded', { mondayItemId, generation, current });
    return { kind: 'superseded', alerted: false };
  }

  const alerted = await deps.alerts.shouldAlert(dlqId);

  // The stored outcome wins if there is one — the failure may have been delivery-only.
  //
  // When there is none, this call creates the authoritative FOUT. There is no compute
  // stage to name, because compute never finished: `dlq_exhausted` says exactly that,
  // and distinguishes it from a terminal failure the engine diagnosed itself.
  const stored = await deps.outcomes.read(mondayItemId, generation);
  const label =
    stored ??
    (await deps.outcomes.claim(mondayItemId, generation, {
      kind: 'failed',
      stage: 'dlq_exhausted',
      message: 'QStash retries exhausted before an outcome was recorded',
      // NULL on purpose, and the reason `failed` permits it: compute never finished, so
      // there is no settings snapshot to name — and the settings read may be exactly
      // what failed. Requiring provenance here would make this FOUT unrecordable and
      // leave the board spinning on `computing` for ever.
      settings: null,
    }));

  if (alerted) {
    log.error('recommendation job dead-lettered', {
      mondayItemId,
      generation,
      dlqId,
      label,
      // Distinguishes "we never got an answer" from "we had one and could not deliver it".
      hadOutcome: stored !== null,
    });
  }

  try {
    const result = await deliverOutcome(
      { queue: deps.store, writer: deps.writer, publisher: deps.publisher },
      { mondayItemId, generation, label }
    );
    if (!result.delivered) {
      return { kind: 'superseded', alerted };
    }
    return { kind: 'delivered', label, alerted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('failure callback: monday write failed', { mondayItemId, generation, message });
    return { kind: 'undeliverable', label, alerted, message };
  }
}
