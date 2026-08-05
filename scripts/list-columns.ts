/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  AGENDA_2026_BOARD,
  MONDAY_API_VERSION,
  INPLANNEN_GROUP_ID,
  RECOMMENDATION_STATUS_COLUMN,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * Read-only: list a board's columns so a hand-created one can be wired up by id.
 *
 * Monday's UI does not surface column ids, and the id is what
 * `MONDAY_RECOMMENDATION_STATUS_COLUMN` needs. Status columns are listed first with
 * their labels, since a mismatched label is the failure this is most often used to
 * diagnose: the writer sends `{"label":"GEREED"}` and Monday rejects a label the
 * column does not define.
 *
 *   pnpm columns:list [boardId]
 */

interface Column {
  id: string;
  title: string;
  type: string;
  settings_str: string | null;
}

function labelsOf(settingsStr: string | null): string[] {
  if (settingsStr === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(settingsStr);
    if (parsed === null || typeof parsed !== 'object' || !('labels' in parsed)) {
      return [];
    }
    const { labels } = parsed;
    if (labels === null || typeof labels !== 'object') {
      return [];
    }
    return Object.values(labels).filter((l): l is string => typeof l === 'string');
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const boardId = process.argv[2] ?? AGENDA_2026_BOARD;
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN');
  }

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const [board] = await client.getSchema([boardId]);
  if (!board) {
    throw new Error(`Board ${boardId} not found (or the token cannot see it)`);
  }

  console.log(`\n${board.name}  (${board.id})\n`);

  // Groups matter for the TRIGGER (a move into Inplannen starts a run), not for the
  // status column: a column belongs to the board, so one column serves every group.
  console.log('GROUPS');
  for (const g of board.groups) {
    const mark = g.id === (process.env.MONDAY_INPLANNEN_GROUP_ID || INPLANNEN_GROUP_ID)
      ? '   ← the trigger group'
      : '';
    console.log(`  ${g.id.padEnd(24)} ${g.title}${mark}`);
  }
  console.log('');

  const columns: Column[] = board.columns;
  const statuses = columns.filter((c) => c.type === 'status');
  const configured = process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN;

  console.log('STATUS COLUMNS');
  for (const c of statuses) {
    const marks: string[] = [];
    if (c.id === RECOMMENDATION_STATUS_COLUMN) {
      marks.push("n8n's — we must never write this");
    }
    if (c.id === configured) {
      marks.push('← configured as ours');
    }
    const labels = labelsOf(c.settings_str);
    console.log(`  ${c.id.padEnd(24)} ${c.title}${marks.length ? `   [${marks.join('; ')}]` : ''}`);
    console.log(`  ${' '.repeat(24)} labels: ${labels.length ? labels.join(' | ') : '(none)'}`);
  }

  console.log('\nOTHER COLUMNS');
  for (const c of columns.filter((col) => col.type !== 'status')) {
    console.log(`  ${c.id.padEnd(24)} ${c.title}  (${c.type})`);
  }

  // The three labels the status writer is allowed to send. A column missing any of
  // them will reject that write at the API, which surfaces as a retry then a DLQ
  // entry rather than anything visible on the board.
  const REQUIRED = ['GEREED', 'GEEN MATCH', 'FOUT'];
  if (configured) {
    const ours = statuses.find((c) => c.id === configured);
    if (!ours) {
      console.log(`\n⚠  MONDAY_RECOMMENDATION_STATUS_COLUMN=${configured} is not a status column here.`);
      return;
    }
    const labels = labelsOf(ours.settings_str);
    const missing = REQUIRED.filter((l) => !labels.includes(l));
    console.log(
      missing.length === 0
        ? `\n✓ ${configured} has all three required labels.`
        : `\n⚠  ${configured} is missing label(s): ${missing.join(', ')}`
    );
  } else {
    console.log('\nMONDAY_RECOMMENDATION_STATUS_COLUMN is not set — pick the id above.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
