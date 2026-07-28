import { RECOMMENDATION_STATUS_COLUMN } from '@lib/monday/board-config';

import type { StatusLabel, StatusWriter } from './delivery';
import { fetchWithRetry } from './http';

/**
 * The scoped Monday status writer — the ONLY thing that writes to Monday. A hard
 * allowlist (the status column id + the terminal labels) makes "we only write the
 * recommendation status" structurally true; anything else throws. RUN is never
 * written (that would self-trigger the webhook). Uses a raw transport so the
 * read client's mutation guard stays intact.
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
  boardId: string;
  columnId?: string;
}

export function createMondayStatusWriter(opts: MondayStatusWriterOptions): StatusWriter {
  const columnId = opts.columnId ?? RECOMMENDATION_STATUS_COLUMN;
  return {
    async writeStatus(itemId: string, label: StatusLabel): Promise<void> {
      if (columnId !== RECOMMENDATION_STATUS_COLUMN) {
        throw new Error(`status writer: refusing to write column ${columnId}`);
      }
      if (!ALLOWED_LABELS.has(label)) {
        throw new Error(`status writer: refusing to write label ${label}`);
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
          },
          body: JSON.stringify({
            query: mutation,
            variables: {
              board: opts.boardId,
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
