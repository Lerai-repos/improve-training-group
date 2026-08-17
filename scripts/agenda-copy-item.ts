/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  AGENDA_2026_PRODUCTION_BOARD,
  MONDAY_API_VERSION,
  RECOMMENDATION_STATUS_COLUMN,
  triggerGroupIds,
} from '@lib/monday/board-config';
import { assertSchemasAgree, buildCopyPayload, diffCells } from '@lib/monday/copy-item';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import type { SourceCell } from '@lib/monday/copy-item';

/**
 * Copy one agenda item to another board, for testing.
 *
 *   pnpm agenda:copy-item <itemId> --to <boardId> [--group <groupId>] [--apply]
 *
 * Exists because Monday has no cross-board copy and the hand-rolled version has a trap
 * in it: board relations report `value: null` while their contents sit in
 * `linked_item_ids`, so the obvious loop drops every link. An agenda item that loses its
 * thema link still looks complete, and then produces a perfectly legitimate GEEN MATCH —
 * which reads as an engine bug. See `lib/monday/copy-item.ts`.
 *
 * Dry-run by default. After `--apply` it reads the copy back and diffs it against the
 * source, because "the mutation returned 200" is not the same as "the item is the same".
 */

/**
 * Every agenda board that holds real trainings.
 *
 * 2025 and 2024 are not archives — they have their own column maps in `board-config.ts`
 * because the engine still reads them, so writing to either is writing to production.
 */
const LIVE_AGENDA_BOARDS: readonly string[] = [
  AGENDA_2026_PRODUCTION_BOARD,
  '1703587792', // Agenda 2025
  '1311331281', // Agenda 2024
];

/** Our own verdict. Copying it would make a fresh fixture look already-computed. */
const NEVER_COPY = [RECOMMENDATION_STATUS_COLUMN, process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN]
  .filter((id): id is string => typeof id === 'string' && id !== '');

/** `value` is what gets written, `text` is what gets compared — see `diffCells`. */
const CELL_FIELDS = 'id type text value ... on BoardRelationValue { linked_item_ids }';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function cellsOf(
  read: ReturnType<typeof createMondayGraphQLClient>,
  itemId: string
): Promise<{ name: string; state: string; boardId: string; cells: SourceCell[] }> {
  const r = await read.query<{
    items: Array<{
      id: string;
      name: string;
      state: string;
      board: { id: string; name: string };
      column_values: SourceCell[];
    }>;
  }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) { id name state board { id name } column_values { ${CELL_FIELDS} } }
     }`,
    { ids: [itemId] }
  );
  const item = r.items[0];
  if (item === undefined) {
    throw new Error(`Item ${itemId} niet gevonden`);
  }
  return {
    name: item.name,
    state: item.state,
    boardId: item.board.id,
    cells: item.column_values,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const sourceId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const target = arg('to');
  const group = arg('group');

  if (!sourceId || !target) {
    throw new Error('Gebruik: pnpm agenda:copy-item <itemId> --to <boardId> [--group <groupId>] [--apply]');
  }
  /**
   * Never INTO a live agenda — and there are THREE of them, not one.
   *
   * Blocking only 2026 was the obvious version and the wrong one: 2025 and 2024 are just
   * as live, still read by the engine (they have their own column maps in
   * `board-config.ts`), and a stray duplicate on one of them is something a human has to
   * find and undo by hand. This command exists to build test fixtures; every real agenda
   * is out of bounds.
   */
  if (LIVE_AGENDA_BOARDS.includes(target)) {
    throw new Error(
      `${target} is een live agendabord. Dit script kopieert alleen NAAR een testbord ` +
        `(geblokkeerd: ${LIVE_AGENDA_BOARDS.join(', ')}).`
    );
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  const [meta] = await read.getSchema([target]);
  if (meta === undefined) {
    throw new Error(`Doelbord ${target} niet gevonden of niet toegankelijk`);
  }
  const targetGroup = group ?? meta.groups[0]?.id;
  if (targetGroup === undefined) {
    throw new Error(`Doelbord ${target} heeft geen groepen`);
  }
  /**
   * The EFFECTIVE trigger groups, not the hard-coded defaults.
   *
   * `MONDAY_TRIGGER_GROUP_IDS` can override them, and the webhook and worker both resolve
   * through `triggerGroupIds()`. Checking the constants instead would let this command
   * drop a fixture straight into the real trigger group on a board whose ids are
   * overridden — where it sits looking planned and is never processed, because the run
   * fires on a MOVE, not on creation.
   */
  if (triggerGroupIds().includes(targetGroup)) {
    throw new Error(
      `Groep ${targetGroup} is een triggergroep. Kopieer naar een andere groep en sleep hem ` +
        'daarna zelf naar Inplannen, zodat de trigger echt afgaat.'
    );
  }

  const { name, cells, boardId: sourceBoard } = await cellsOf(read, sourceId);
  if (sourceBoard === target) {
    throw new Error(
      `Bron en doel zijn hetzelfde bord (${target}). Gebruik Monday's eigen "dupliceren" ` +
        'voor een kopie binnen één bord.'
    );
  }
  const { values, skipped, unreadable } = buildCopyPayload(cells, { skipColumnIds: NEVER_COPY });
  const [sourceMeta] = await read.getSchema([sourceBoard]);
  if (sourceMeta === undefined) {
    throw new Error(`Bronbord ${sourceBoard} niet leesbaar`);
  }

  console.log(apply ? 'APPLY\n' : 'DRY RUN — er wordt niets geschreven\n');
  console.log(`bron   : "${name}" (${sourceId}) op ${sourceMeta?.name ?? sourceBoard}`);
  console.log(`doel   : bord ${meta.name} (${target}), groep ${targetGroup}`);
  console.log(`kolommen: ${Object.keys(values).length} gekopieerd`);
  const relations = Object.entries(values).filter(
    ([, v]) => typeof v === 'object' && v !== null && 'item_ids' in v
  );
  console.log(
    `relaties: ${relations.length ? relations.map(([id]) => id).join(', ') : 'geen'}`
  );
  if (skipped.length > 0) {
    console.log(`overgeslagen: ${skipped.map((s) => `${s.columnId} (${s.reason})`).join(', ')}`);
  }
  /**
   * Refused BEFORE the create, not after.
   *
   * An unreadable value means the copy is already known to be incomplete. Writing it
   * anyway and letting the read-back object leaves a half-built item on the board that
   * somebody has to notice and delete — and on a shared test board, half-built fixtures
   * are exactly what makes a later test confusing.
   */
  if (unreadable.length > 0) {
    throw new Error(
      `Kan de waarde van ${unreadable.join(', ')} niet lezen. Er wordt niets aangemaakt: ` +
        'die kolom(men) zouden leeg blijven en dan is de kopie stil onvolledig.'
    );
  }
  // Checked on the dry run too — the whole point of a preview is to find this here.
  assertSchemasAgree(sourceMeta, meta);
  if (!apply) {
    console.log('\nDraai opnieuw met --apply om dit echt te doen.');
    return;
  }

  const res = await write.mutate<{ create_item: { id: string } }>(
    `mutation ($b: ID!, $g: String!, $n: String!, $v: JSON!) {
       create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id }
     }`,
    { b: target, g: targetGroup, n: name, v: JSON.stringify(values) },
    /**
     * Unique PER INVOCATION, not per (board, item).
     *
     * The key exists to make a transport retry inside this run safe. Keeping it stable
     * across runs sounds tidier and is worse: Monday remembers it for 30 minutes, so
     * copying the same training twice — or retrying after deleting a bad copy — silently
     * replays the first response instead of creating anything. That really happened here:
     * the command reported an id that had just been deleted. Making a second fixture is
     * cheap; being handed a stale one and not knowing is not.
     */
    { idempotencyKey: `copy:${target}:${sourceId}:${randomUUID()}` }
  );
  const copyId = res.create_item.id;
  console.log(`\naangemaakt: ${copyId}`);

  // Read back and compare. A 200 says the request was accepted, not that every value
  // landed — which is exactly how the relations went missing the first time.
  const { state, cells: copied } = await cellsOf(read, copyId);
  if (state !== 'active') {
    // Named explicitly, because as a column diff it looks like a copying bug rather than
    // an item that was never created.
    throw new Error(
      `Monday gaf item ${copyId} terug, maar dat is '${state}'. Waarschijnlijk kreeg je een ` +
        'herhaald antwoord op een eerdere aanvraag. Draai het commando opnieuw.'
    );
  }
  const diff = diffCells(cells, copied, { skipColumnIds: NEVER_COPY });
  if (diff.length > 0) {
    throw new Error(
      `De kopie wijkt af van de bron op: ${diff.join(', ')}. Controleer die kolommen met de hand.`
    );
  }
  console.log('✓ kopie is identiek aan de bron (buiten de bewust overgeslagen kolommen)');
}

main().catch((error: unknown) => {
  console.error('\nagenda:copy-item failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
