/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAdminSupabaseClient } from '@lib/db/admin';
import { assertNonProdTarget, resolveAdminDbUrl } from '@lib/db/target';
import {
  AGENDA_2026_BOARD,
  AGENDA_2026_COLUMNS,
  AGENDA_EXPECTED_COLUMNS,
  GROUP_POLICY,
  ITEM_FIELDS,
  MONDAY_API_VERSION,
  resolveGroupPolicy,
  THEMA_EXPECTED_COLUMNS,
  THEMA_QUAL_COLOURS,
  THEMAS_BOARD,
  TRAINER_COLUMNS,
  TRAINER_EXPECTED_COLUMNS,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import {
  decodeQualificationsFromThema,
  decodeThema,
  decodeTrainer,
  decodeTraining,
  type Diagnostic,
  type RawMondayItem,
} from '@lib/monday/decode';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { assertColumns, checkSourceDrop } from '@lib/monday/schema-check';
import {
  EMPTY_ACK,
  parseAcknowledgements,
  validateSnapshot,
  type Acknowledgements,
  type Anomaly,
} from '@lib/monday/validate';
import type { MondayTraining } from '@lib/monday';
import { applyArtifact } from '@lib/sync/apply';
import { buildArtifact } from '@lib/sync/artifact';

const REQUESTED_API_VERSION = MONDAY_API_VERSION;
const RUNS_DIR = join(process.cwd(), 'snapshots', 'monday', 'runs');
const ACK_FILE = join(process.cwd(), 'docs', 'm2a', 'acknowledgements.json');

type Totals = Record<string, number | null>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Provenance hash of BOTH the mapping configuration (board ids, column maps,
 * expected schemas, group policy, pinned API version) AND the reviewed
 * acknowledgements file — so a run is tied to the exact config that decoded it.
 */
function configHash(): string {
  const ack = existsSync(ACK_FILE) ? readFileSync(ACK_FILE, 'utf8') : 'EMPTY_ACK';
  const mapping = {
    apiVersion: REQUESTED_API_VERSION,
    boards: { agenda: AGENDA_2026_BOARD, trainers: TRAINERS_BOARD, themas: THEMAS_BOARD },
    columns: {
      agenda: AGENDA_2026_COLUMNS,
      trainer: TRAINER_COLUMNS,
      qualColours: THEMA_QUAL_COLOURS,
    },
    expected: {
      agenda: AGENDA_EXPECTED_COLUMNS,
      trainer: TRAINER_EXPECTED_COLUMNS,
      themas: THEMA_EXPECTED_COLUMNS,
    },
    groupPolicy: GROUP_POLICY,
  };
  return sha256(`${JSON.stringify(mapping)}\n${ack}`);
}

function loadAck(): Acknowledgements {
  if (!existsSync(ACK_FILE)) {
    return EMPTY_ACK;
  }
  // Strict runtime validation — a mistyped key/value (e.g. "allowSourceDrop":"false")
  // must fail loudly, not silently permit a destructive run.
  return parseAcknowledgements(JSON.parse(readFileSync(ACK_FILE, 'utf8')));
}

/** The BASELINE manifest — written only after a CLEAN dry-run (source-drop baseline). */
function manifestPath(accountId: string): string {
  return join(RUNS_DIR, `dry-run-${accountId}.json`);
}
/** A failed dry-run is recorded separately so it never poisons the baseline. */
function failedManifestPath(accountId: string): string {
  return join(RUNS_DIR, `dry-run-${accountId}-failed.json`);
}

/** Coerce an untyped jsonb value into board Totals (numbers or null), no casts. */
function coerceTotals(value: unknown): Totals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const out: Totals = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === 'number' ? v : null;
  }
  return out;
}

/** Merge two jsonb baselines (board totals + artifact section counts) into one map. */
function combineBaseline(boardTotals: unknown, artifactCounts: unknown): Totals | null {
  const b = coerceTotals(boardTotals);
  const c = coerceTotals(artifactCounts);
  if (!b && !c) {
    return null;
  }
  return { ...(b ?? {}), ...(c ?? {}) };
}

/** Previous combined baseline (board totals + section counts) from the last clean dry-run. */
function previousDryRunCombined(accountId: string): Totals | null {
  const path = manifestPath(accountId);
  if (!existsSync(path)) {
    return null;
  }
  const m: { boardTotals?: Totals; counts?: Totals } = JSON.parse(readFileSync(path, 'utf8'));
  return combineBaseline(m.boardTotals, m.counts);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local or Doppler)');
  }

  const ack = loadAck();

  // --apply: resolve the ACTUAL admin URL and refuse a non-local target. Create
  // the run record BEFORE preflight so any early-stage failure is still recorded.
  let admin: ReturnType<typeof createAdminSupabaseClient> | null = null;
  let dbUrl: string | null = null;
  let runId: string | null = null;
  if (apply) {
    dbUrl = resolveAdminDbUrl();
    assertNonProdTarget(dbUrl);
    admin = createAdminSupabaseClient();
    const run = await admin
      .from('sync_runs')
      .insert({
        mode: 'apply',
        scope: { boardId: AGENDA_2026_BOARD },
        target: dbUrl,
        status: 'running',
      })
      .select('id')
      .single();
    if (run.error) {
      throw new Error(`sync_runs insert: ${run.error.message}`);
    }
    runId = run.data.id;
  }
  console.log(`Mode: ${apply ? `APPLY → ${dbUrl}` : 'DRY-RUN (no DB writes)'}`);

  let stage = 'preflight';
  try {
    const client = createMondayGraphQLClient({ token, apiVersion: REQUESTED_API_VERSION });
    const pre = await client.preflight();
    console.log(`Authenticated as ${pre.account.name}; API-Version ${pre.reportedVersion}`);

    stage = 'schema';
    const schema = await client.getSchema([AGENDA_2026_BOARD, TRAINERS_BOARD, THEMAS_BOARD]);
    const board = (id: string) => schema.find((b) => b.id === id);
    const agendaBoard = board(AGENDA_2026_BOARD);
    const trainersBoard = board(TRAINERS_BOARD);
    const themasBoard = board(THEMAS_BOARD);
    if (!agendaBoard || !trainersBoard || !themasBoard) {
      throw new Error('a configured board was not returned by Monday');
    }
    // Fatal on schema drift (a retyped relation column would silently empty its links).
    assertColumns(agendaBoard, AGENDA_EXPECTED_COLUMNS);
    assertColumns(trainersBoard, TRAINER_EXPECTED_COLUMNS);
    assertColumns(themasBoard, THEMA_EXPECTED_COLUMNS);
    const totals: Totals = {
      agenda: agendaBoard.items_count,
      trainers: trainersBoard.items_count,
      themas: themasBoard.items_count,
    };

    stage = 'fetch';
    const [agendaRaw, trainersRaw, themasRaw] = await Promise.all([
      client.fetchBoardItems<RawMondayItem>(AGENDA_2026_BOARD, ITEM_FIELDS, totals.agenda),
      client.fetchBoardItems<RawMondayItem>(TRAINERS_BOARD, ITEM_FIELDS, totals.trainers),
      client.fetchBoardItems<RawMondayItem>(THEMAS_BOARD, ITEM_FIELDS, totals.themas),
    ]);

    stage = 'decode';
    const diagnostics: Diagnostic[] = [];
    const trainers = trainersRaw.map((it) => {
      const { value, diagnostics: d } = decodeTrainer(it, TRAINER_COLUMNS);
      diagnostics.push(...d);
      return { ...value, rateKey: resolveGroupPolicy(value.mondayGroup)?.rateKey ?? null };
    });
    const themas = themasRaw.map((it) => {
      const { value, diagnostics: d } = decodeThema(it);
      diagnostics.push(...d);
      return value;
    });
    const trainings = agendaRaw.map((it) => {
      const { value, diagnostics: d } = decodeTraining(it, AGENDA_2026_COLUMNS);
      diagnostics.push(...d);
      return value;
    });
    const qualifications = themasRaw.flatMap((it) =>
      decodeQualificationsFromThema(it, THEMA_QUAL_COLOURS)
    );

    stage = 'validate';
    const validation = validateSnapshot({
      trainers,
      themas,
      trainings,
      qualifications,
      diagnostics,
      ack,
    });

    // Inject derived klant links, then build the artifact (needed for the drop guard).
    const klantByTraining = new Map<string, string[]>();
    for (const link of validation.trainingKlant) {
      klantByTraining.set(link.trainingExt, [
        ...(klantByTraining.get(link.trainingExt) ?? []),
        link.klantExt,
      ]);
    }
    const trainingsWithKlant: MondayTraining[] = trainings.map((t) => ({
      ...t,
      klantExternalIds: klantByTraining.get(t.externalItemId) ?? [],
    }));
    const artifact = buildArtifact({
      boardId: AGENDA_2026_BOARD,
      trainers,
      themas,
      klanten: validation.klanten,
      trainings: trainingsWithKlant,
      qualifications,
      conflictOverrides: validation.conflictOverrides,
    });

    // Source-drop guard over BOTH board totals AND artifact section counts — so a
    // mass clear of relations/qualifications (board totals unchanged) is caught too.
    const current: Totals = { ...totals, ...artifact.counts };
    let prevCombined: Totals | null = null;
    if (apply && admin) {
      const prev = await admin
        .from('sync_runs')
        .select('board_totals, artifact_counts')
        .eq('status', 'ok')
        .eq('mode', 'apply')
        .eq('target', dbUrl ?? '')
        .not('artifact_counts', 'is', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Fail closed: a failed baseline lookup must NOT silently disable the drop guard.
      if (prev.error) {
        throw new Error(`baseline lookup failed: ${prev.error.message}`);
      }
      prevCombined = combineBaseline(prev.data?.board_totals, prev.data?.artifact_counts);
      // First apply: no DB baseline yet → fall back to the last CLEAN dry-run manifest.
      if (!prevCombined) {
        prevCombined = previousDryRunCombined(pre.account.id);
      }
    } else {
      prevCombined = previousDryRunCombined(pre.account.id);
    }
    const drop = checkSourceDrop(current, prevCombined, ack.allowSourceDrop ?? {});
    const anomalies: Anomaly[] = drop ? [...validation.anomalies, drop] : validation.anomalies;
    // No baseline → the drop guard is inert. Bootstrapping is allowed only with an
    // explicit acknowledgement whose EXPECTED counts match the live counts exactly
    // (evidence-bound + recorded), else fatal.
    if (!prevCombined) {
      const expected = ack.allowNoBaseline ?? {};
      // The acknowledgement must cover the COMPLETE count map (identical key sets),
      // else a partial `{agenda: 756}` would pass even if every relation/qual count
      // collapsed to zero.
      const expKeys = Object.keys(expected).sort();
      const curKeys = Object.keys(current).sort();
      const sameKeys =
        expKeys.length === curKeys.length && expKeys.every((k, i) => k === curKeys[i]);
      const matches = sameKeys && curKeys.every((k) => current[k] === expected[k]);
      if (matches) {
        anomalies.push({
          kind: 'no_baseline_bootstrapped',
          severity: 'allowed',
          detail: 'no prior baseline; bootstrapped with acknowledged counts',
          ids: [JSON.stringify(expected)],
        });
      } else {
        anomalies.push({
          kind: 'no_baseline',
          severity: 'fatal',
          detail:
            'no prior baseline; set allowNoBaseline to the expected current counts to bootstrap',
        });
      }
    }
    const fatalCount = anomalies.filter((a) => a.severity === 'fatal').length;

    console.log('Counts:', JSON.stringify(artifact.counts));
    for (const a of anomalies) {
      console.log(
        `  [${a.severity.toUpperCase()}] ${a.kind}: ${a.detail}${a.ids ? ` (${a.ids.length})` : ''}`
      );
    }

    if (!apply) {
      mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
      const clean = fatalCount === 0;
      const manifest = {
        mode: 'dry-run',
        account: pre.account,
        apiVersion: pre.reportedVersion,
        boardTotals: totals,
        counts: artifact.counts,
        fatalCount,
        anomalies,
      };
      // Only a CLEAN run updates the baseline; a fatal run is recorded separately
      // so a 754→5 drop can't become the next run's 5→5 "no drop" baseline.
      const out = clean ? manifestPath(pre.account.id) : failedManifestPath(pre.account.id);
      writeFileSync(out, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      console.log(`Dry-run manifest → ${out}`);
      if (!clean) {
        console.error(
          `\nDRY-RUN FAILED: ${fatalCount} fatal anomaly group(s) — resolve the worklist above.`
        );
        process.exit(1);
      }
      console.log('\nDry-run clean. Re-run with --apply against a non-prod target to write.');
      return;
    }

    if (fatalCount > 0) {
      throw new Error(`refusing --apply: ${fatalCount} fatal anomaly group(s)`);
    }

    stage = 'apply';
    if (!admin || !runId) {
      throw new Error('apply mode without an admin client / run id');
    }
    await applyArtifact(admin, artifact, {
      runId,
      target: dbUrl,
      boardTotals: totals,
      anomalies,
      schemaHash: sha256(JSON.stringify(schema)),
      configHash: configHash(),
    });
    console.log(`\nApplied. sync_runs ${runId} = ok.`);
  } catch (err) {
    if (apply && admin && runId) {
      // Only mark a run failed if it is STILL running — the RPC commits + sets
      // 'ok' in-transaction, so a lost response / post-apply error must not
      // overwrite a genuinely committed run.
      const upd = await admin
        .from('sync_runs')
        .update({ status: 'failed', failing_stage: stage, finished_at: new Date().toISOString() })
        .eq('id', runId)
        .eq('status', 'running');
      if (upd.error) {
        console.error(`ALSO failed to record the failure in sync_runs: ${upd.error.message}`);
      }
      // If the row is actually 'ok', the apply committed despite the error path.
      const check = await admin.from('sync_runs').select('status').eq('id', runId).single();
      if (check.data?.status === 'ok') {
        console.warn(`\nNote: sync_runs ${runId} is committed 'ok' despite an error after apply.`);
        return;
      }
    }
    throw err;
  }
}

main().catch((error) => {
  console.error('sync-monday failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
