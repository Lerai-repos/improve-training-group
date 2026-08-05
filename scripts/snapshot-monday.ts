/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

// tsx does not auto-load .env.local (also works under `doppler run`, which
// injects the vars directly and makes this a no-op).
loadEnv({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  agendaBoardId,
  ITEM_FIELDS,
  MONDAY_API_VERSION,
  THEMAS_BOARD,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * Read-only snapshot: dumps the in-scope boards to gitignored `snapshots/monday/`
 * (0600) with a completion manifest. The fail-closed transport (auth, timeout,
 * retry/backoff, API-Version assertion, complete + coherent pagination) lives in
 * `createMondayGraphQLClient` — this script only orchestrates + writes, so there
 * is ONE copy of that logic shared with the live sync.
 */

const TOKEN = process.env.MONDAY_API_TOKEN;
const OUT_DIR = join(process.cwd(), 'snapshots', 'monday');

// Boards in scope for M2a (see docs .../platform-structures/monday.md).
const BOARDS: Record<string, string> = {
  'agenda-2026': agendaBoardId(),
  trainers: TRAINERS_BOARD,
  themas: THEMAS_BOARD,
};

interface SnapshotColumn {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
  __typename?: string;
  linked_item_ids?: string[] | null;
  display_value?: string | null;
}

interface SnapshotItem {
  id: string;
  name: string;
  updated_at: string | null;
  board: { id: string } | null;
  group: { id: string; title: string } | null;
  column_values: SnapshotColumn[];
}

/** Write a JSON file (0600) and return the sha256 of its exact bytes. */
function writeJson(name: string, data: unknown): string {
  const content = JSON.stringify(data, null, 2);
  const path = join(OUT_DIR, `${name}.json`);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return createHash('sha256').update(content).digest('hex');
}

async function main(): Promise<void> {
  if (!TOKEN) {
    throw new Error('Missing MONDAY_API_TOKEN in .env.local (or run via `doppler run`).');
  }
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);

  const client = createMondayGraphQLClient({ token: TOKEN, apiVersion: MONDAY_API_VERSION });

  // Stage 1 — preflight (versions + account) and schema inventory.
  const pre = await client.preflight();
  console.log(
    `Monday API supported: ${pre.supportedVersions.join(', ')} — pinned ${MONDAY_API_VERSION}`
  );
  console.log(`Authenticated as ${pre.account.name} (id ${pre.account.id})`);

  const schema = await client.getSchema(Object.values(BOARDS));
  const countById = new Map(schema.map((b) => [b.id, b.items_count]));
  for (const b of schema) {
    console.log(
      `  board ${b.id} "${b.name}": ${b.columns.length} columns, ${b.groups.length} groups, items_count=${b.items_count}`
    );
  }

  // Stage 2 — fetch + validate EVERY board (gated: complete + coherent) into memory
  // first; nothing is written until all boards pass, so a mid-run failure can't
  // leave a mixed snapshot dir for the audit to consume.
  const pending: Array<{ name: string; items: SnapshotItem[] }> = [];
  const summary: Record<string, { fetched: number; itemsCount: number | null }> = {};
  for (const [name, boardId] of Object.entries(BOARDS)) {
    console.log(`Fetching ${name} (${boardId})…`);
    const items = await client.fetchBoardItems<SnapshotItem>(
      boardId,
      ITEM_FIELDS,
      countById.get(boardId) ?? null
    );
    pending.push({ name, items });
    summary[name] = {
      fetched: new Set(items.map((i) => i.id)).size,
      itemsCount: countById.get(boardId) ?? null,
    };
    console.log(`  ${name}: ${items.length} items (coherent, complete)`);
  }

  // All boards passed — commit the whole snapshot, recording each file's hash. meta
  // (the completion marker + hash manifest) is written LAST, so a partial/failed
  // write leaves a stale/absent meta and the audit's manifest check will reject it.
  const files: Record<string, string> = {};
  files['schema'] = writeJson('schema', schema);
  for (const { name, items } of pending) {
    files[name] = writeJson(name, items);
  }
  writeJson('meta', {
    fetchedAt: new Date().toISOString(),
    apiVersionRequested: MONDAY_API_VERSION,
    apiVersionReported: pre.reportedVersion,
    account: pre.account,
    boards: BOARDS,
    summary,
    files,
  });

  console.log('\nMonday snapshot complete → snapshots/monday/ (gitignored, 0600).');
}

main().catch((error) => {
  console.error('Snapshot failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
