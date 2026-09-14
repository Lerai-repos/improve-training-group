import { log } from '@lib/logger';
import { ourStatusColumnId, RECOMMENDATION_STATUS_COLUMN } from '@lib/monday/board-config';

import type { StatusLabel, StatusWriter } from './delivery';
import { fetchWithRetry } from './http';

/**
 * The scoped Monday status writer — the ONLY thing that writes to Monday. A hard
 * allowlist (one status column id + the three terminal labels) makes "we only write
 * the recommendation status" structurally true; anything else throws. RUN is never
 * written (that would self-trigger the webhook). Uses a raw transport so the read
 * client's mutation guard stays intact.
 *
 * The refusal is INVERTED from the original: this engine now writes its OWN column
 * and must never touch `RECOMMENDATION_STATUS_COLUMN`, which n8n still owns. Until
 * our results are provably clean the two run side by side, and a write into n8n's
 * column would quietly end that comparison.
 */

const MONDAY_URL = 'https://api.monday.com/v2';
const ALLOWED_LABELS = new Set<StatusLabel>(['GEREED', 'GEEN MATCH', 'FOUT']);
// The write must finish well within the 60s delivery lease so a hung Monday call
// can't outlive the lease and race a takeover worker's mutation. 2 × 12s + backoff
// (≈ 24.5s) stays under it; the label write is idempotent so retrying is safe.
const WRITE_ATTEMPTS = 2;
const WRITE_TIMEOUT_MS = 12000;

export interface MondayStatusWriterOptions {
  token: string;
  apiVersion: string;
  /**
   * The board this item lives on, or `null` when the engine does not serve that board.
   *
   * Per item and not one configured board: ITG runs several agenda boards at once (2026
   * and its 2027 copy), and `change_column_value` needs the item's own board. Resolved at
   * write time rather than carried through the queue, so the job payload, the Redis record
   * and every recovery path (sweep, repair, failure callback) stay exactly as they were.
   * A lookup that fails must THROW, so the write is retried.
   */
  boardFor: (itemId: string) => Promise<string | null>;
  columnId?: string;
}

export function createMondayStatusWriter(opts: MondayStatusWriterOptions): StatusWriter {
  const columnId = opts.columnId ?? ourStatusColumnId();
  return {
    async writeStatus(itemId, label, writeOpts): Promise<void> {
      if (columnId === RECOMMENDATION_STATUS_COLUMN) {
        throw new Error(
          `status writer: refusing to write ${columnId} — that column belongs to n8n`
        );
      }
      if (!ALLOWED_LABELS.has(label)) {
        throw new Error(`status writer: refusing to write label ${label}`);
      }
      const boardId = await opts.boardFor(itemId);
      if (boardId === null) {
        /**
         * Skipped, not thrown. The item is no longer on a board we serve: archived, moved,
         * or the board lost its status column. Retrying cannot change that, and a throw would
         * send an answer nobody can see through every retry into the dead-letter queue. The
         * outcome itself is recorded, so the item view still shows it.
         */
        log.warn('status writer: item is not on a served agenda board, label not written', {
          itemId,
          label,
        });
        return;
      }
      const mutation =
        'mutation ($board: ID!, $item: ID!, $col: String!, $val: JSON!) { change_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) { id } }';
      const res = await fetchWithRetry(
        MONDAY_URL,
        {
          method: 'POST',
          headers: {
            Authorization: opts.token,
            'Content-Type': 'application/json',
            'API-Version': opts.apiVersion,
            // Deterministic per (training, generation): Monday suppresses a repeat of
            // the SAME mutation for 30 minutes, so an at-least-once redelivery does
            // not double-apply. It does NOT order writes — that is the generation
            // recheck's job — so nothing here depends on it for correctness.
            ...(writeOpts?.idempotencyKey === undefined
              ? {}
              : { 'Idempotency-Key': writeOpts.idempotencyKey }),
          },
          body: JSON.stringify({
            query: mutation,
            variables: {
              board: boardId,
              item: itemId,
              col: columnId,
              val: JSON.stringify({ label }),
            },
          }),
        },
        { attempts: WRITE_ATTEMPTS, timeoutMs: WRITE_TIMEOUT_MS }
      );
      if (!res.ok) {
        throw new Error(`Monday status write ${res.status}: ${await res.text()}`);
      }
      const body: { errors?: Array<{ message: string }> } = await res.json();
      if (body.errors && body.errors.length > 0) {
        throw new Error(
          `Monday status write errors: ${body.errors.map((e) => e.message).join('; ')}`
        );
      }
    },
  };
}
