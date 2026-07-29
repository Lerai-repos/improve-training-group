/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAdminSupabaseClient } from '@lib/db/admin';
import { assertNonProdTarget, resolveAdminDbUrl } from '@lib/db/target';
import { EMPTY_ACK, parseAcknowledgements } from '@lib/monday';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildEngineConfig,
  createMondayReader,
  createStubAddressFormatter,
  createStubTravelProvider,
  createSupabaseTravelCache,
  newWorkerOwner,
  runRecommendation,
  type ServiceDeps,
} from '@lib/recommend';

/**
 * Parity: M2b vs the legacy Airtable "Aanbevelingen" for a sample of trainings.
 *
 * The eligibility comparison is the point — and the KEY expected divergence is that
 * M2b is green-only (the client collapsed the stoplicht) while legacy allowed
 * Oranje. So an "only-legacy" trainer whose legacy Qualification contained
 * Oranje/Grijs/Rood is an EXPECTED exclusion; a pure-Groen only-legacy trainer (or
 * an only-M2b trainer) is a real diff to explain (usually board drift since the
 * July snapshot). Travel is stubbed (eligibility is pre-travel), so this needs only
 * the Monday token. Writes docs/m2a/recommend-parity.md.
 *
 *   pnpm recommend:parity [--limit N]
 */

const AT_DIR = join(process.cwd(), 'snapshots', 'airtable');
const REPORT = join(process.cwd(), 'docs', 'm2a', 'recommend-parity.md');
const ACK_FILE = join(process.cwd(), 'docs', 'm2a', 'acknowledgements.json');

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

function readAt(name: string): AirtableRecord[] {
  return JSON.parse(readFileSync(join(AT_DIR, `${name}.json`), 'utf8'));
}
function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
}

interface LegacyRec {
  trainerPulse: string;
  naam: string;
  qualification: string;
}

function buildLegacy(): Map<string, LegacyRec[]> {
  const trainingen = readAt('trainingen');
  const trainers = readAt('trainers');
  const aanbevelingen = readAt('aanbevelingen');

  const trainingPulseByRec = new Map<string, string>();
  for (const t of trainingen) {
    const pulse = str(t.fields['Monday Pulse ID']);
    if (pulse) trainingPulseByRec.set(t.id, pulse);
  }
  const trainerByRec = new Map<string, { pulse: string; naam: string }>();
  for (const t of trainers) {
    const pulse = str(t.fields['Monday Pulse ID']);
    if (pulse) trainerByRec.set(t.id, { pulse, naam: str(t.fields['Naam']) ?? '?' });
  }

  const byTraining = new Map<string, LegacyRec[]>();
  for (const a of aanbevelingen) {
    const trainingRec = str(a.fields['Record ID Training']) ?? firstLink(a.fields['Training']);
    const trainerRec = firstLink(a.fields['Trainer']);
    if (!trainingRec || !trainerRec) continue;
    const trainingPulse = trainingPulseByRec.get(trainingRec);
    const trainer = trainerByRec.get(trainerRec);
    if (!trainingPulse || !trainer) continue;
    const list = byTraining.get(trainingPulse) ?? [];
    list.push({
      trainerPulse: trainer.pulse,
      naam: str(a.fields['Naam Trainer']) ?? trainer.naam,
      qualification: str(a.fields['Qualification']) ?? '',
    });
    byTraining.set(trainingPulse, list);
  }
  return byTraining;
}

const isColourExcluded = (qual: string): boolean => /oranje|grijs|rood/i.test(qual);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 12;

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('Missing MONDAY_API_TOKEN');
  assertNonProdTarget(resolveAdminDbUrl());
  const admin = createAdminSupabaseClient();

  const legacy = buildLegacy();
  console.log(`Legacy Aanbevelingen: ${legacy.size} trainings with recommendations.`);

  // Sample trainings present in BOTH the legacy recs and the current Monday snapshot.
  const { data: present } = await admin
    .from('trainings')
    .select('external_item_id')
    .is('deleted_at', null);
  const presentPulses = new Set(
    (present ?? []).map((t) => t.external_item_id).filter((x): x is string => x !== null)
  );
  const sample = [...legacy.keys()].filter((p) => presentPulses.has(p)).slice(0, limit);
  // Refuse to write an empty report: an unsynced/reset DB yields 0 overlap, and
  // writing it would silently overwrite a previously-good parity report with zeros.
  if (sample.length === 0) {
    throw new Error(
      `No overlap between the legacy snapshot (${legacy.size} trainings) and the local ` +
        `snapshot (${presentPulses.size} trainings) — run \`pnpm sync:monday --apply\` first ` +
        `(without --apply it is a dry run and writes nothing). ` +
        `Refusing to overwrite ${REPORT}.`
    );
  }
  console.log(`Sampling ${sample.length} trainings present in both.\n`);

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const deps: ServiceDeps = {
    admin,
    reader: createMondayReader(client),
    addressFormatter: createStubAddressFormatter({ kind: 'no_travel_confirmed', reason: 'online' }),
    travelProvider: createStubTravelProvider(() => ({
      status: 'ok',
      leg: { distanceKm: 0, durationMinutes: 0 },
    })),
    travelCache: createSupabaseTravelCache(admin),
    ack: existsSync(ACK_FILE)
      ? parseAcknowledgements(JSON.parse(readFileSync(ACK_FILE, 'utf8')))
      : EMPTY_ACK,
    config: await buildEngineConfig(admin),
  };

  const rows: string[] = [];
  let matched = 0;
  let onlyLegacyExcluded = 0;
  let onlyLegacyUnexplained = 0;
  let onlyM2b = 0;
  let foutCount = 0;
  let erroredCount = 0;

  for (const pulse of sample) {
    const legacyRecs = legacy.get(pulse) ?? [];
    const legacySet = new Map(legacyRecs.map((r) => [r.trainerPulse, r]));

    const enq = await admin.rpc('enqueue_recommendation_run', {
      p_trigger_uuid: `parity-${pulse}-${Date.now()}`,
      p_trigger_kind: 'group_move',
      p_monday_item_id: pulse,
    });
    if (enq.error || !enq.data) {
      erroredCount += 1;
      rows.push(
        `| ${pulse} | ERROR (enqueue: ${enq.error?.message ?? 'no run'}) | ${legacyRecs.length} | — | — | — |`
      );
      continue;
    }
    // Claim THIS run by id — claiming the oldest queued run would compute a
    // different training against the current parity row with any backlog present.
    const claim = await admin.rpc('claim_recommendation_run_by_id', {
      p_run_id: enq.data.id,
      p_owner: newWorkerOwner(),
      p_lease_seconds: 120,
    });
    const run = claim.data?.[0];
    if (!run) {
      erroredCount += 1;
      rows.push(
        `| ${pulse} | ERROR (claim: ${claim.error?.message ?? 'not claimable'}) | ${legacyRecs.length} | — | — | — |`
      );
      continue;
    }
    const outcome = await runRecommendation(deps, {
      id: run.id,
      monday_item_id: run.monday_item_id,
      generation: run.generation,
    });
    if (outcome.resultStatus === 'FOUT') {
      foutCount += 1;
      rows.push(`| ${pulse} | FOUT (${outcome.failingStage}) | ${legacyRecs.length} | — | — | — |`);
      continue;
    }

    const recs = await admin
      .from('recommendations')
      .select('trainers(external_item_id)')
      .eq('run_id', run.id);
    if (recs.error) {
      erroredCount += 1;
      rows.push(
        `| ${pulse} | ERROR (recs: ${recs.error.message}) | ${legacyRecs.length} | — | — | — |`
      );
      continue;
    }
    const m2bSet = new Set(
      (recs.data ?? [])
        .map((r) => r.trainers?.external_item_id)
        .filter((x): x is string => typeof x === 'string')
    );

    let tMatched = 0;
    let tOnlyLegacyExcl = 0;
    let tOnlyLegacyUnexpl = 0;
    let tOnlyM2b = 0;
    for (const tp of m2bSet) {
      if (legacySet.has(tp)) tMatched += 1;
      else tOnlyM2b += 1;
    }
    for (const [tp, rec] of legacySet) {
      if (m2bSet.has(tp)) continue;
      if (isColourExcluded(rec.qualification)) tOnlyLegacyExcl += 1;
      else tOnlyLegacyUnexpl += 1;
    }
    matched += tMatched;
    onlyLegacyExcluded += tOnlyLegacyExcl;
    onlyLegacyUnexplained += tOnlyLegacyUnexpl;
    onlyM2b += tOnlyM2b;
    rows.push(
      `| ${pulse} | ${outcome.resultStatus} | ${legacyRecs.length} | ${m2bSet.size} | ${tMatched} | +${tOnlyM2b} / -${tOnlyLegacyExcl}(oranje) / -${tOnlyLegacyUnexpl}(?) |`
    );
    console.log(
      `  ${pulse}: legacy ${legacyRecs.length}, m2b ${m2bSet.size}, matched ${tMatched}, oranje-excl ${tOnlyLegacyExcl}, unexplained ${tOnlyLegacyUnexpl}, only-m2b ${tOnlyM2b}`
    );
  }

  const report = [
    '# M2b vs legacy Airtable Aanbevelingen — parity',
    '',
    `Sample: ${sample.length} trainings present in both the legacy Aanbevelingen snapshot and the current Monday board.`,
    'Travel is stubbed (eligibility is pre-travel); this compares the recommended trainer SETS.',
    '',
    '**Expected divergence:** M2b is green-only (client collapsed the stoplicht); legacy allowed Oranje.',
    'So an only-legacy trainer whose legacy Qualification contained Oranje/Grijs/Rood is an EXPECTED',
    'exclusion. Only a pure-Groen only-legacy trainer, or an only-M2b trainer, is a real diff.',
    '',
    '> **NOTE — this file is GENERATED by `pnpm recommend:parity`. Do not hand-edit it;**',
    '> **anything added here is overwritten on the next run.**',
    '',
    '## Investigating a non-colour diff',
    '',
    '**These counts do NOT certify themselves.** The sampled trainings and the live board both change',
    'between runs, so every `pure-groen` / `only-M2b` diff in THIS report must be investigated afresh —',
    'an earlier run concluding "no defects" says nothing about these rows.',
    '',
    'For each such trainer × training, compare three things:',
    '',
    '1. the legacy row: its `Qualification` AND its `Created` date — Aanbevelingen is an append-only log,',
    '   never recomputed, so an old row reflects the board as it was *then*, not now;',
    '2. the live Monday colour columns for that trainer on that theme — all four (a trainer listed in',
    '   BOTH groen and rood is an unresolved conflict that M2b deliberately fails closed on);',
    '3. whether the trainer sits in a selected group with a resolvable rate (`pnpm groups:list`).',
    '',
    'A diff explained by (1) or (2) is data drift. Anything left unexplained is a genuine engine',
    'difference and should be treated as a defect until shown otherwise. Record conclusions in',
    '`docs/m2a/parity-diff-investigation.md` (hand-written, never regenerated) — not in this file.',
    '',
    '## Aggregate',
    `- sampled trainings: **${sample.length}** (processed ${sample.length - erroredCount}, errored ${erroredCount})`,
    `- matched (in both): **${matched}**`,
    `- only-legacy, colour-excluded (expected — oranje/grijs/rood): **${onlyLegacyExcluded}**`,
    `- only-legacy, pure-groen (REVIEW — drift or discrepancy): **${onlyLegacyUnexplained}**`,
    `- only-M2b (new green / board drift): **${onlyM2b}**`,
    `- M2b FOUT on this training: **${foutCount}**`,
    `- errored (enqueue/claim/query failure — NOT compared): **${erroredCount}**`,
    '',
    '## Per training',
    '| Training | M2b status | legacy # | m2b # | matched | diff |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(REPORT, report);
  console.log(
    `\nAggregate → matched ${matched}, oranje-excluded ${onlyLegacyExcluded}, unexplained ${onlyLegacyUnexplained}, only-m2b ${onlyM2b}, fout ${foutCount}, errored ${erroredCount}`
  );
  console.log(`Report → ${REPORT}`);
}

main().catch((error) => {
  console.error('recommend-parity failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
