/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  MONDAY_API_VERSION,
  recommendableGroups,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import {
  buildSettingsSnapshot,
  groepenKeyPrefix,
  normaliseName,
  provisionGroepselectie,
  readSettings,
  CATEGORIES,
  INITIAL_ROWS,
  SETTINGS_EXPECTED_COLUMNS,
} from '@lib/settings';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';

/**
 * Create the Instellingen board, once.
 *
 *   pnpm instellingen:create              # dry run — prints what it would do
 *   pnpm instellingen:create --apply
 *   pnpm instellingen:create --apply --resume <boardId>
 *
 * ## Dry-run by default, unlike the cron
 *
 * A human runs this straight after editing a column id, and it writes to ITG's
 * workspace. The nightly job defaults the other way for the opposite reason.
 *
 * ## Idempotent at the MUTATION, not merely resumable
 *
 * Persisting the board id after `create_board` returns does not cover the case that
 * actually bites: Monday creates the board and the **response is lost**, so a transport
 * retry creates a second one before any id can be written down. Every create therefore
 * carries a deterministic `Idempotency-Key`, generated and persisted BEFORE the first
 * request, and reused across retries.
 *
 * Monday keeps that key for 30 minutes. Past the window it protects nothing, and
 * `--resume` cannot help either because no board id was ever received — so an
 * unresolved create past expiry is REFUSED rather than resent, and asks a human to find
 * the candidate board. Creating a second Instellingen board silently would be far worse
 * than stopping.
 *
 * Every column, group and row invariant is checked independently, so a re-run repairs a
 * half-built board rather than no-opping because "the board exists".
 */

/** Monday's idempotency retention. Past this the key is no longer a guarantee. */
const IDEMPOTENCY_WINDOW_MS = 30 * 60 * 1000;

const INTENT_FILE = join(process.cwd(), '.instellingen-create.json');

/**
 * The agenda boards' own workspace — "Agenda (oude hoofdwerkruimte)", verified live.
 *
 * Without it Monday drops the board in the token's default workspace, where nobody
 * would think to look for it.
 */
const WORKSPACE_ID = '5308763';

/**
 * PRIVATE, exactly like the agenda boards.
 *
 * "Everyone can edit" means everyone who plans trainings — the people who already have
 * the agenda boards. A public board would additionally expose ITG's rates and margins
 * to everyone in the account, which is a wider audience than anybody asked for.
 *
 * Note this cannot be changed afterwards: `update_board` only accepts name, description
 * and communication, so a board created with the wrong kind has to be replaced.
 */
const BOARD_KIND = 'private';

const BOARD_NAME = 'Instellingen';
const NOTITIES_GROUP = 'Notities';
const SETTINGS_GROUP = 'Instellingen';

/**
 * `uncaptured` is safe to act on precisely because nothing of ours exists yet: the
 * capture happens immediately after `create_board` and before any column, group or row
 * is written, so at that point "everything on the board" IS Monday's sample content.
 * That invariant is re-checked on a resume rather than assumed — see `resolveSamples`.
 */
type SampleState =
  | { phase: 'uncaptured' }
  | { phase: 'captured'; itemIds: string[]; groupIds: string[] }
  | { phase: 'cleared' };

interface Intent {
  runId: string;
  startedAt: number;
  boardId: string | null;
  /**
   * Where sample cleanup got to. THREE states, not a nullable pair.
   *
   * `null` conflated three different situations — done, never started, and crashed
   * between persisting the board id and capturing the samples — and the recovery path
   * that matters most fell in the gap: after a LOST `create_board` response the id was
   * never written down, so `--resume <discoveredBoardId>` had nothing to carry over and
   * skipped cleanup entirely, reporting success on a board still holding "Task 1".
   *
   * Ids rather than a flag, because a flag says cleanup is unfinished without saying
   * WHAT is left — forcing a resume to re-derive it as "everything on the board", which
   * once our own rows exist would delete all seven settings.
   */
  samples: SampleState;
}

function readIntent(): Intent | null {
  if (!existsSync(INTENT_FILE)) {
    return null;
  }
  return JSON.parse(readFileSync(INTENT_FILE, 'utf8')) as Intent;
}

function writeIntent(intent: Intent): void {
  writeFileSync(INTENT_FILE, `${JSON.stringify(intent, null, 2)}\n`);
}

/** Deterministic per operation, so a retry reuses the key rather than minting a new one. */
const keyFor = (intent: Intent, op: string): string => `${intent.runId}:${op}`;

interface Ctx {
  read: ReturnType<typeof createMondayGraphQLClient>;
  write: MondayMutationClient;
  apply: boolean;
  intent: Intent;
  /** Monday's sample groups, deleted once ours exist. Empty on a resume. */
  defaultGroupIds: string[];
}

function say(ctx: Ctx, what: string): void {
  console.log(`${ctx.apply ? '  APPLY ' : '  would '}${what}`);
}

async function ensureBoard(ctx: Ctx): Promise<string> {
  if (ctx.intent.boardId !== null) {
    const [meta] = await ctx.read.getSchema([ctx.intent.boardId]);
    if (meta === undefined) {
      throw new Error(
        `Board ${ctx.intent.boardId} uit ${INTENT_FILE} bestaat niet (meer). Verwijder het ` +
          'bestand als je opnieuw wilt beginnen, of geef het juiste --resume <boardId>.'
      );
    }
    console.log(`  board bestaat al: ${meta.name} (${meta.id})`);

    // A resume finishes whatever cleanup is outstanding — see `resolveSamples` for how
    // the three states are told apart, and why capturing is safe in only one of them.
    if (ctx.apply) {
      ctx.defaultGroupIds = await resolveSamples(ctx, meta);
    }
    return meta.id;
  }

  const age = Date.now() - ctx.intent.startedAt;
  if (age > IDEMPOTENCY_WINDOW_MS) {
    // The key no longer protects us and there is no id to resume from. Resending would
    // risk a SECOND Instellingen board that nothing points at.
    throw new Error(
      `Er staat een onafgeronde create van ${Math.round(age / 60000)} minuten geleden in ` +
        `${INTENT_FILE}, en Monday's idempotency-venster (30 min) is verlopen.\n` +
        'Zoek in de workspace of er al een "Instellingen"-board is aangemaakt:\n' +
        '  - zo ja:  pnpm instellingen:create --apply --resume <boardId>\n' +
        `  - zo nee: verwijder ${INTENT_FILE} en draai opnieuw.`
    );
  }

  say(ctx, `create ${BOARD_KIND} board "${BOARD_NAME}" in workspace ${WORKSPACE_ID}`);
  if (!ctx.apply) {
    return '(dry-run)';
  }

  const result = await ctx.write.mutate<{ create_board: { id: string } }>(
    `mutation ($name: String!, $workspace: ID!) {
       create_board(board_name: $name, board_kind: ${BOARD_KIND}, workspace_id: $workspace) { id }
     }`,
    { name: BOARD_NAME, workspace: WORKSPACE_ID },
    { idempotencyKey: keyFor(ctx.intent, 'create_board') }
  );

  const boardId = result.create_board.id;
  // Persisted IMMEDIATELY: everything after this is repairable, losing the id is not.
  writeIntent({ ...ctx.intent, boardId });
  ctx.intent.boardId = boardId;
  console.log(`  board aangemaakt: ${boardId} (opgeslagen in ${INTENT_FILE})`);

  ctx.defaultGroupIds = await clearMondayDefaults(ctx, boardId);
  return boardId;
}

/**
 * Remove the sample content Monday puts on every new board.
 *
 * A new board arrives with a "Task 1"/"Task 2" in a default group, and the settings
 * reader refuses an unrecognised row outside `Notities` — correctly, since that is how
 * a typo'd key is caught. So the board would be unreadable from the moment it was
 * created unless the samples go.
 *
 * Only ever called in the branch that JUST created the board, so "everything currently
 * here is Monday's, not ITG's" is true by construction. The ids are PERSISTED before
 * anything is deleted, so a resume finishes the job against that recorded set rather
 * than re-deriving it from a board that by then contains our own rows.
 *
 * The sample GROUP cannot go yet — Monday refuses to delete a board's last group — so
 * its id is kept and removed once ours exist.
 */
async function clearMondayDefaults(ctx: Ctx, boardId: string): Promise<string[]> {
  const [meta] = await ctx.read.getSchema([boardId]);
  const items = await ctx.read.fetchBoardItems<{ id: string; name: string; updated_at?: string | null }>(
    boardId,
    'id name updated_at',
    meta?.items_count ?? null
  );

  const samples: SampleState = {
    phase: 'captured',
    itemIds: items.map((i) => i.id),
    groupIds: (meta?.groups ?? []).map((g) => g.id),
  };
  // Persisted BEFORE the first delete: this is the only moment at which "what is on
  // this board" and "what is Monday's sample content" are the same set.
  writeIntent({ ...ctx.intent, samples });
  ctx.intent.samples = samples;

  await deleteSampleItems(ctx, samples.itemIds);
  return samples.groupIds;
}

/**
 * What is left to clean on a board we are resuming onto.
 *
 * The dangerous case is `uncaptured` arriving with a `--resume` — the recovery path
 * after a lost `create_board` response, where the board exists but its id was never
 * written down. Cleanup is still owed there, and skipping it hands over a board
 * `readSettings` refuses. But capturing blindly is how a re-run over a FINISHED board
 * would delete all seven settings.
 *
 * So the invariant is checked rather than assumed. Our columns are created strictly
 * after cleanup, so their presence proves the board is past this stage; their absence
 * proves nothing of ours exists yet and everything present is Monday's.
 */
async function resolveSamples(ctx: Ctx, meta: BoardMeta): Promise<string[]> {
  const { samples } = ctx.intent;

  if (samples.phase === 'cleared') {
    return [];
  }
  if (samples.phase === 'captured') {
    await deleteSampleItems(ctx, samples.itemIds);
    return samples.groupIds;
  }

  const ours = new Set(SETTINGS_EXPECTED_COLUMNS.map((c) => c.id));
  if (meta.columns.some((c) => ours.has(c.id))) {
    // Past the sample stage: cleanup ran, we simply never recorded that it had.
    console.log('  sample cleanup was already done (our columns exist)');
    writeIntent({ ...ctx.intent, samples: { phase: 'cleared' } });
    ctx.intent.samples = { phase: 'cleared' };
    return [];
  }

  await assertPristineInstellingen(ctx, meta);
  console.log('  board is still pristine — capturing and clearing Monday’s samples');
  return clearMondayDefaults(ctx, meta.id);
}

/** Monday's own sample rows are "Task 1", "Task 2", … */
const SAMPLE_ITEM = /^Task \d+$/i;

/**
 * Refuse to treat anything but a freshly-created Instellingen board as pristine.
 *
 * The absence of our column ids does NOT prove a board is ours and empty — it is also
 * true of every OTHER board in the account. So a mistyped `--resume` pointing at, say,
 * Agenda 2026 would have had its contents captured as "Monday samples" and deleted.
 * That is the worst thing this script could possibly do, and it is one typo away.
 *
 * So identity is proved positively — name, workspace, and contents that actually look
 * like Monday's untouched samples — and anything else stops and asks for a human.
 */
async function assertPristineInstellingen(ctx: Ctx, meta: BoardMeta): Promise<void> {
  const refuse = (why: string): never => {
    throw new Error(
      `Weiger sample-cleanup op board ${meta.id} ("${meta.name}"): ${why}.\n` +
        'Dit board ziet er niet uit als een net aangemaakt Instellingen-board. Controleer ' +
        `het board-id; verwijder anders ${INTENT_FILE} en begin opnieuw.`
    );
  };

  if (meta.name !== BOARD_NAME) {
    refuse(`het heet "${meta.name}", niet "${BOARD_NAME}"`);
  }

  const data = await ctx.read.query<{ boards: Array<{ workspace_id: string | null }> | null }>(
    'query ($ids: [ID!]) { boards(ids: $ids) { workspace_id } }',
    { ids: [meta.id] }
  );
  const workspace = data.boards?.[0]?.workspace_id ?? null;
  if (String(workspace) !== WORKSPACE_ID) {
    refuse(`het staat in workspace ${String(workspace)}, niet ${WORKSPACE_ID}`);
  }

  // Exactly one group is what a brand-new board has. Ours are added later, so anything
  // else means this board has been worked on — and `dropDefaultGroups` would delete
  // whatever is captured here.
  if (meta.groups.length !== 1) {
    refuse(`het heeft ${meta.groups.length} groepen; een net aangemaakt board heeft er één`);
  }

  const items = await ctx.read.fetchBoardItems<{ id: string; name: string; updated_at?: string | null }>(
    meta.id,
    'id name updated_at',
    meta.items_count
  );

  /**
   * A POSITIVE signature, not merely the absence of a stranger.
   *
   * `strangers.length > 0` passed vacuously on an EMPTY board — so an empty board that
   * happened to be called Instellingen, in the right workspace, would have been accepted
   * as pristine and had its groups deleted. "Nothing that looks wrong" is not the same
   * as "looks like Monday's samples".
   *
   * If Monday ever creates a board with no sample rows this refuses a legitimate resume,
   * which is the right direction to fail: it asks for a human rather than deleting.
   */
  if (items.length === 0) {
    refuse('het is leeg; een net aangemaakt board heeft nog Monday-voorbeeldrijen');
  }
  const strangers = items.filter((i) => !SAMPLE_ITEM.test(i.name.trim()));
  if (strangers.length > 0) {
    refuse(`het bevat rijen die geen Monday-voorbeeld zijn (${strangers[0].name})`);
  }
}

/**
 * Tolerates an id that is genuinely gone, and ONLY that.
 *
 * A resume re-runs this over a partial deletion, so "already deleted" has to be
 * survivable. But swallowing every error would let an auth failure, a timeout or a rate
 * limit read as confirmed-absent — and the run would then go on to mark cleanup
 * complete without knowing whether the sample is still there. So a failure is followed
 * by an explicit existence check, and anything that is not a confirmed absence is
 * rethrown.
 */
async function deleteSampleItems(ctx: Ctx, itemIds: readonly string[]): Promise<void> {
  for (const id of itemIds) {
    try {
      await ctx.write.mutate('mutation ($id: ID!) { delete_item(item_id: $id) { id } }', { id });
      console.log(`  APPLY delete Monday's sample item ${id}`);
    } catch (error) {
      if (await itemExists(ctx, id)) {
        throw new Error(`Kon sample-item ${id} niet verwijderen: ${message(error)}`);
      }
      console.log(`  sample item ${id} was al weg`);
    }
  }
}

/** A deleted item is simply absent from `items(ids:)`. */
async function itemExists(ctx: Ctx, id: string): Promise<boolean> {
  const data = await ctx.read.query<{ items: Array<{ id: string }> | null }>(
    'query ($ids: [ID!]) { items(ids: $ids) { id } }',
    { ids: [id] }
  );
  return (data.items ?? []).length > 0;
}

/** Same rule for groups: confirmed-missing is success, anything else propagates. */
async function groupExists(ctx: Ctx, boardId: string, groupId: string): Promise<boolean> {
  const [meta] = await ctx.read.getSchema([boardId]);
  return (meta?.groups ?? []).some((g) => g.id === groupId);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removed only after our own groups exist, since a board must always have one. */
async function dropDefaultGroups(ctx: Ctx, boardId: string): Promise<void> {
  for (const groupId of ctx.defaultGroupIds) {
    try {
      await ctx.write.mutate(
        'mutation ($board: ID!, $group: String!) { delete_group(board_id: $board, group_id: $group) { id } }',
        { board: boardId, group: groupId }
      );
      console.log(`  APPLY delete Monday's sample group ${groupId}`);
    } catch (error) {
      // Group deletion is not idempotent at the response boundary: Monday may have
      // deleted it and lost the reply. Retrying then fails forever on a group that is
      // already gone, which would strand the whole resumable workflow.
      if (await groupExists(ctx, boardId, groupId)) {
        throw new Error(`Kon sample-groep ${groupId} niet verwijderen: ${message(error)}`);
      }
      console.log(`  sample group ${groupId} was al weg`);
    }
  }
  // Only NOW is the board free of Monday's samples, so only now may a resume skip this.
  if (ctx.apply && ctx.intent.boardId !== null) {
    writeIntent({ ...ctx.intent, samples: { phase: 'cleared' } });
    ctx.intent.samples = { phase: 'cleared' };
  }
}

async function ensureGroup(ctx: Ctx, boardId: string, title: string): Promise<string> {
  const [meta] = await ctx.read.getSchema([boardId]);
  const existing = meta?.groups.find((g) => g.title === title);
  if (existing !== undefined) {
    console.log(`  groep bestaat al: ${title} (${existing.id})`);
    return existing.id;
  }

  say(ctx, `create group "${title}"`);
  if (!ctx.apply) {
    return `(dry-run:${title})`;
  }

  const result = await ctx.write.mutate<{ create_group: { id: string } }>(
    'mutation ($board: ID!, $name: String!) { create_group(board_id: $board, group_name: $name) { id } }',
    { board: boardId, name: title },
    { idempotencyKey: keyFor(ctx.intent, `group:${title}`) }
  );
  return result.create_group.id;
}

async function ensureColumns(ctx: Ctx, boardId: string, meta: BoardMeta | undefined): Promise<void> {
  const byId = new Map((meta?.columns ?? []).map((c) => [c.id, c]));

  for (const expected of SETTINGS_EXPECTED_COLUMNS) {
    const found = byId.get(expected.id);
    if (found !== undefined) {
      if (found.type !== expected.type) {
        throw new Error(
          `Kolom ${expected.id} bestaat maar is type '${found.type}', verwacht '${expected.type}'. ` +
            'Handmatig corrigeren; dit script overschrijft geen bestaande kolom.'
        );
      }
      console.log(`  kolom bestaat al: ${expected.id}`);
      continue;
    }

    const defaults =
      expected.id === 'itg_categorie'
        ? JSON.stringify({ labels: Object.fromEntries(CATEGORIES.map((l, i) => [i + 1, l])) })
        : null;

    say(ctx, `create column ${expected.id} (${expected.type})`);
    if (!ctx.apply) {
      continue;
    }
    await ctx.write.mutate(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $id: String, $defaults: JSON) {
         create_column(board_id: $board, title: $title, column_type: $type, id: $id, defaults: $defaults) { id }
       }`,
      {
        board: boardId,
        title: titleFor(expected.id),
        type: expected.type,
        // A PINNED custom id. Monday would otherwise generate one, and the reader keys
        // on ids precisely so a rename cannot break it.
        id: expected.id,
        defaults,
      },
      { idempotencyKey: keyFor(ctx.intent, `column:${expected.id}`) }
    );
  }
}

function titleFor(columnId: string): string {
  if (columnId === 'itg_waarde') {
    return 'Waarde';
  }
  return columnId === 'itg_categorie' ? 'Categorie' : 'Omschrijving';
}

async function ensureRows(ctx: Ctx, boardId: string, groupId: string): Promise<void> {
  const existing = ctx.apply
    ? await ctx.read.fetchBoardItems<{ id: string; name: string; updated_at?: string | null }>(
        boardId,
        'id name updated_at',
        (await ctx.read.getSchema([boardId]))[0]?.items_count ?? null
      )
    : [];
  /**
   * Keyed by NORMALISED name, matching what the reader does.
   *
   * A literal comparison is weaker than the contract: the reader folds case, spacing and
   * separators, so a row renamed to "hq adres" resolves fine there while a literal check
   * here sees it as missing — creating a second canonical row, and a duplicate key is
   * exactly what `readSettings` refuses.
   */
  const present = new Set(existing.map((i) => normaliseName(i.name)));

  for (const row of INITIAL_ROWS) {
    if (present.has(normaliseName(row.name))) {
      console.log(`  rij bestaat al: ${row.name}`);
      continue;
    }
    say(ctx, `create item "${row.name}" = ${row.waarde}`);
    if (!ctx.apply) {
      continue;
    }
    await ctx.write.mutate(
      `mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) { id }
       }`,
      {
        board: boardId,
        group: groupId,
        name: row.name,
        // Values travel WITH the create, so a row is never visible in a half-filled
        // state — the same reason the phase-2a selection is seeded atomically.
        values: JSON.stringify({
          itg_waarde: row.waarde,
          itg_omschrijving: row.omschrijving,
          itg_categorie: { label: row.categorie },
        }),
      },
      { idempotencyKey: keyFor(ctx.intent, `item:${row.name}`) }
    );
  }
}

/**
 * Read the finished board back THROUGH THE ENGINE'S OWN READER before claiming success.
 *
 * Counting successful mutations only proves each request returned 200. It cannot see a
 * duplicate key, a row somebody left blank, a setting sitting in the wrong group, or a
 * value that does not parse — every one of which `readSettings` refuses and none of
 * which this script would otherwise notice. The contract is "the engine can read this
 * board", so that is what gets checked.
 */
async function verifyReadable(
  ctx: Ctx,
  boardId: string,
  notitiesGroupId: string,
  groepenOptions: ReadonlyMap<string, string>
): Promise<void> {
  if (!ctx.apply) {
    return;
  }
  try {
    const raw = await readSettings(ctx.read, { boardId, notitiesGroupId, groepenOptions });
    const snapshot = buildSettingsSnapshot(raw, {
      boardId,
      isProduction: false,
      /**
       * A board this script builds is COMPLETE, so it is verified against the strict
       * rules rather than the transitional ones — otherwise the one command that could
       * catch a missing `TRAINERGROEPEN` row is the one that skips the check.
       */
      requireTrainerGroups: true,
      readAt: Date.now(),
      env: process.env,
    });
    console.log(
      `\n  ✓ leesbaar door de engine — fingerprint ${snapshot.fingerprint.slice(0, 12)}, ` +
        `${snapshot.rateCards.length} tarieven`
    );
  } catch (error) {
    throw new Error(
      `Board is aangemaakt maar de engine kan het niet lezen: ${message(error)}\n` +
        'Corrigeer het board en draai dit script opnieuw — het repareert wat ontbreekt.'
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const resumeAt = args.indexOf('--resume');
  const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : undefined;

  // `--resume` as the last argument would otherwise leave `resumeId` undefined and fall
  // straight through to the CREATE path — which with `--apply` and no prior intent
  // makes a SECOND board out of what was meant to be a recovery.
  if (resumeAt >= 0 && (resumeId === undefined || resumeId.startsWith('--'))) {
    throw new Error('--resume vereist een board-id: pnpm instellingen:create --apply --resume <boardId>');
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }

  const previous = readIntent();
  /**
   * The run id seeds every `Idempotency-Key`, so reusing it across a DIFFERENT board
   * would let Monday dedupe a column or item mutation against the same operation on the
   * old board — within the 30-minute window, silently doing nothing.
   *
   * Kept only when the resume targets the same board, or when the persisted board id is
   * null: that is the lost-`create_board`-response case, where reusing the key is the
   * entire point.
   */
  const sameRun =
    previous !== null && (previous.boardId === resumeId || previous.boardId === null);

  const intent: Intent = resumeId
    ? {
        runId: sameRun ? previous.runId : randomUUID(),
        startedAt: Date.now(),
        boardId: resumeId,
        /**
         * Carried over when the persisted intent describes this same board. Otherwise
         * `uncaptured` — NOT "nothing to do": a board handed in by id is usually the
         * one whose `create_board` response was lost, which still holds Monday's
         * samples. `resolveSamples` decides safely from the board's own state.
         */
        samples:
          previous?.boardId === resumeId
            ? (previous?.samples ?? { phase: 'uncaptured' as const })
            : { phase: 'uncaptured' as const },
      }
    : (previous ?? {
        runId: randomUUID(),
        startedAt: Date.now(),
        boardId: null,
        samples: { phase: 'uncaptured' },
      });
  if (apply) {
    // Before the FIRST request, so a lost response still has a key to retry with.
    writeIntent(intent);
  }

  const ctx: Ctx = {
    read: createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION }),
    write: createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION }),
    apply,
    intent,
    defaultGroupIds: [],
  };

  console.log(apply ? 'APPLY — writing to Monday\n' : 'DRY RUN — nothing is written\n');

  const boardId = await ensureBoard(ctx);
  const meta = apply ? (await ctx.read.getSchema([boardId]))[0] : undefined;
  await ensureColumns(ctx, boardId, meta);
  const settingsGroup = await ensureGroup(ctx, boardId, SETTINGS_GROUP);
  const notitiesGroup = await ensureGroup(ctx, boardId, NOTITIES_GROUP);
  await ensureRows(ctx, boardId, settingsGroup);
  await dropDefaultGroups(ctx, boardId);

  /**
   * The trainer-group selection is part of a complete board, not an optional extra.
   *
   * Seeded from `recommendableGroups()` and NOT from `loadSettingsOnce`: a board created
   * seconds ago has no prior effective selection, and reading the live configuration
   * would answer from the PINNED PRODUCTION board — the wrong source entirely for the
   * fresh preview board this usually builds.
   */
  const [trainers] = await ctx.read.getSchema([TRAINERS_BOARD]);
  const { optionMap } = await provisionGroepselectie({
    read: ctx.read,
    write: ctx.write,
    boardId,
    notitiesGroupId: notitiesGroup,
    // Seeded from THIS run, so the same operation on a different board never dedupes
    // against it inside Monday's 30-minute window.
    keyPrefix: `${groepenKeyPrefix(boardId)}:${ctx.intent.runId}`,
    apply,
    // On a dry run `ensureBoard` hands back a synthetic id, so there is no board to
    // inspect and every query against it would fail. Describing is the point here.
    plannedBoard: !apply,
    selection: recommendableGroups(),
    titles: new Map((trainers?.groups ?? []).map((g) => [g.id, g.title])),
    log: (line) => console.log(`  ${line}`),
  });

  await verifyReadable(ctx, boardId, notitiesGroup, optionMap);

  console.log('\n── Vast te leggen in lib/settings/board.ts ──');
  console.log('export const INSTELLINGEN_PRODUCTION: SettingsBoardConfig = {');
  console.log(`  boardId: '${boardId}',`);
  console.log(`  notitiesGroupId: '${notitiesGroup}',`);
  if (optionMap.size === 0) {
    // A dry run has no ids to show — Monday assigns them. Printing an empty map would
    // look like a value to paste, and a partial option map is refused on purpose.
    console.log('  // groepenOptions: pas bekend na --apply');
  } else {
    console.log('  groepenOptions: new Map([');
    for (const [id, group] of optionMap) {
      console.log(`    ['${id}', '${group}'],`);
    }
    console.log('  ]),');
  }
  console.log('};');
  console.log(
    '\nDeze twee horen bij elkaar: Monday geeft elk board zijn eigen groep-id, ' +
      'dus een preview-board heeft een andere Notities-groep.'
  );
  if (apply) {
    console.log(`\nKlaar. Verwijder ${INTENT_FILE} zodra dit is vastgelegd.`);
  }
}

main().catch((error: unknown) => {
  console.error('\ninstellingen:create failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
