import { Client, Receiver } from '@upstash/qstash';
import { z } from 'zod';

import type { JobPublisher, PublishedJob } from './queue';

/**
 * QStash as the durable job transport. It owns what the deleted Postgres worker
 * hand-rolled — retries with backoff, redelivery, and a dead-letter queue the SQL
 * design never had (a run that killed its worker was reclaimed forever).
 *
 * Two settings here are load-bearing rather than tuning:
 *
 *  - **Flow Control** keyed per training with `parallelism: 1`. QStash holds a second
 *    message for that training until the first call returns, which is what keeps
 *    concurrent compute for one training rare. Keys are unlimited and independent, so
 *    unrelated trainings are never serialized behind each other — the reason this
 *    beats one global FIFO queue.
 *
 *  - **`timeout` ABOVE the route's `maxDuration`.** A shorter timeout would release
 *    the Flow Control slot and deliver the next message while our function was still
 *    running, manufacturing the very overlap the design works to avoid. Vercel must
 *    always be the one that kills the execution first.
 */

/** Must stay > `maxDuration` (300s) on the job route. See above. */
export const JOB_TIMEOUT_SECONDS = 330;

/** Delivery attempts before QStash gives up and fires the failure callback. */
export const JOB_RETRIES = 3;

export interface QStashPublisherOptions {
  client: Client;
  /** Publicly reachable URL of the job route. */
  jobUrl: string;
  /** Publicly reachable URL of the failure-callback route. */
  failureUrl: string;
}

export function createQStashPublisher(opts: QStashPublisherOptions): JobPublisher {
  return {
    async publish(job: PublishedJob): Promise<void> {
      await opts.client.publishJSON({
        url: opts.jobUrl,
        body: job,
        // Collapses Monday's retry storm, and makes a resumed publish safe: if the
        // first attempt reached QStash but its response was lost, the retry is
        // deduplicated rather than queued twice — the original message still runs.
        // The client documents these ids as retained for 90 days; nothing here
        // depends on the window, which is why the durable Redis record exists.
        deduplicationId: job.triggerUuid,
        flowControl: { key: `training-${job.mondayItemId}`, parallelism: 1 },
        retries: JOB_RETRIES,
        timeout: JOB_TIMEOUT_SECONDS,
        failureCallback: opts.failureUrl,
      });
    },
  };
}

/**
 * Verify a QStash delivery against the EXACT raw body and URL, before any parsing.
 * The signature covers the bytes as sent, so re-serializing a parsed object first
 * would compare a different payload and reject every legitimate call.
 */
export async function verifyQStashRequest(request: Request, rawBody: string): Promise<boolean> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error('Missing QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY');
  }
  const signature = request.headers.get('upstash-signature');
  if (!signature) {
    return false;
  }
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  try {
    return await receiver.verify({ signature, body: rawBody, url: request.url });
  } catch {
    // A malformed or mismatched signature throws rather than returning false.
    return false;
  }
}

/**
 * `JSON.parse` that yields null instead of throwing. The routes need this: a throw
 * would escape their deliberate non-retryable branch and become a plain 500, which
 * QStash reads as "try again" — so a permanently malformed body would be redelivered
 * until its retries ran out rather than failing fast.
 */
export function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const jobPayloadSchema = z.object({
  triggerUuid: z.string().min(1),
  mondayItemId: z.string().min(1),
  generation: z.number().int().positive(),
  hop: z.number().int().nonnegative().optional(),
});

/**
 * QStash's failure callback wraps the original message: the body we published is
 * base64 in `sourceBody`, alongside the DLQ id.
 */
const failureCallbackSchema = z.object({
  dlqId: z.string().min(1),
  sourceBody: z.string(),
});

export interface ParsedFailureCallback {
  dlqId: string;
  job: z.infer<typeof jobPayloadSchema>;
}

export function parseFailureCallback(body: unknown): ParsedFailureCallback | null {
  const envelope = failureCallbackSchema.safeParse(body);
  if (!envelope.success) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope.data.sourceBody, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const job = jobPayloadSchema.safeParse(decoded);
  return job.success ? { dlqId: envelope.data.dlqId, job: job.data } : null;
}

export function createQStashClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error('Missing QSTASH_TOKEN');
  }
  return new Client({ token });
}

/**
 * Public base URL for the callbacks QStash makes back into this app. `VERCEL_URL`
 * carries no scheme and is per-deployment; an explicit override is what makes local
 * tunnelling (and a stable production domain) work.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  const vercel = process.env.VERCEL_URL;
  if (vercel) {
    return `https://${vercel}`;
  }
  throw new Error('Missing PUBLIC_BASE_URL (or VERCEL_URL) for the QStash callback URLs');
}
