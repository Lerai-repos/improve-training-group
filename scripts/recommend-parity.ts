/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_ACK, parseAcknowledgements } from '@lib/monday';
import { ITEM_FIELDS, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildEngineConfig,
  createMondayReader,
  createStubAddressFormatter,
  createStubTravelProvider,
  createMemoryTravelCacheStore,
  createTravelCache,
  readRoster,
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

/**
 * Is this trainer effective-GREEN for every theme of the training, right now?
 *
 * The legacy Aanbevelingen table is an APPEND-ONLY LOG: a row records what was true
 * when it was written and is never recomputed. So "legacy said Groen, we don't
 * recommend them" is usually not a defect — the board has moved since (ITG switched
 * to a groen/rood working method on 30 July 2026 and has been re-qualifying in
 * bulk). Classifying against the frozen legacy string alone cannot tell that apart
 * from a real regression, which is the whole point of this bucket.
 */
function isGreenNow(
  effective: ReadonlyArray<{
    trainerExternalId: string;
    themaExternalId: string;
    effective: string | null;
  }>,
  trainerPulse: string,
  themeIds: readonly string[]
): boolean {
  if (themeIds.length === 0) {
    return false;
  }
  return themeIds.every((theme) =>
    effective.some(
      (e) =>
        e.trainerExternalId === trainerPulse &&
        e.themaExternalId === theme &&
        e.effective === 'green'
    )
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 12;

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('Missing MONDAY_API_TOKEN');

  const legacy = buildLegacy();
  console.log(`Legacy Aanbevelingen: ${legacy.size} trainings with recommendations.`);

  // No local mirror to intersect with any more: take the legacy trainings directly
  // and let a training that no longer exists on the board surface as load_training.
  const sample = [...legacy.keys()].slice(0, limit);
  // Refuse to write an empty report: an unsynced/reset DB yields 0 overlap, and
  // writing it would silently overwrite a previously-good parity report with zeros.
  if (sample.length === 0) {
    // Refuse to write an empty report — it would overwrite a good one with zeros.
    throw new Error(`No legacy Aanbevelingen found in ${AT_DIR}. Refusing to overwrite ${REPORT}.`);
  }
  console.log(`Sampling ${sample.length} trainings present in both.\n`);

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  // Roster read ONCE for the whole sweep: the board read costs several Monday calls,
  // so re-reading it per sampled training would multiply that against a 25.000/day
  // budget for no benefit.
  const roster = await readRoster(client, ITEM_FIELDS);
  console.log(`Roster: ${roster.length} trainers (live, all groups)\n`);

  const deps: ServiceDeps = {
    roster,
    reader: createMondayReader(client),
    addressFormatter: createStubAddressFormatter({ kind: 'no_travel_confirmed', reason: 'online' }),
    travelProvider: createStubTravelProvider(() => ({
      status: 'ok',
      leg: { distanceKm: 0, durationMinutes: 0 },
    })),
    travelCache: createTravelCache(createMemoryTravelCacheStore()),
    ack: existsSync(ACK_FILE)
      ? parseAcknowledgements(JSON.parse(readFileSync(ACK_FILE, 'utf8')))
      : EMPTY_ACK,
    config: buildEngineConfig(),
  };

  const rows: string[] = [];
  let matched = 0;
  let onlyLegacyExcluded = 0;
  let onlyLegacyRequalified = 0;
  let onlyLegacyUnexplained = 0;
  let onlyM2b = 0;
  let foutCount = 0;
  let erroredCount = 0;

  for (const pulse of sample) {
    const legacyRecs = legacy.get(pulse) ?? [];
    const legacySet = new Map(legacyRecs.map((r) => [r.trainerPulse, r]));

    const result = await runRecommendation(deps, pulse);
    if (!result.ok) {
      foutCount += 1;
      rows.push(`| ${pulse} | FOUT (${result.failure.stage}) | ${legacyRecs.length} | — | — | — |`);
      continue;
    }
    const m2bSet = new Set(result.recommendations.map((r) => r.externalItemId));
    const themeIds = result.artifact.training.themeExternalIds;

    let tMatched = 0;
    let tOnlyLegacyExcl = 0;
    let tOnlyLegacyRequal = 0;
    let tOnlyLegacyUnexpl = 0;
    let tOnlyM2b = 0;
    for (const tp of m2bSet) {
      if (legacySet.has(tp)) tMatched += 1;
      else tOnlyM2b += 1;
    }
    for (const [tp, rec] of legacySet) {
      if (m2bSet.has(tp)) continue;
      if (isColourExcluded(rec.qualification)) {
        tOnlyLegacyExcl += 1;
      } else if (!isGreenNow(result.artifact.qualifications.effective, tp, themeIds)) {
        // Legacy said Groen, but the live board no longer does — a stale legacy row.
        tOnlyLegacyRequal += 1;
      } else {
        // Green then AND green now, yet we don't recommend them: a real signal.
        tOnlyLegacyUnexpl += 1;
      }
    }
    matched += tMatched;
    onlyLegacyExcluded += tOnlyLegacyExcl;
    onlyLegacyRequalified += tOnlyLegacyRequal;
    onlyLegacyUnexplained += tOnlyLegacyUnexpl;
    onlyM2b += tOnlyM2b;
    rows.push(
      `| ${pulse} | ${result.resultStatus} | ${legacyRecs.length} | ${m2bSet.size} | ${tMatched} | +${tOnlyM2b} / -${tOnlyLegacyExcl}(oranje) / -${tOnlyLegacyRequal}(requal) / -${tOnlyLegacyUnexpl}(?) |`
    );
    console.log(
      `  ${pulse}: legacy ${legacyRecs.length}, m2b ${m2bSet.size}, matched ${tMatched}, oranje-excl ${tOnlyLegacyExcl}, requalified ${tOnlyLegacyRequal}, unexplained ${tOnlyLegacyUnexpl}, only-m2b ${tOnlyM2b}`
    );
  }

  const report = [
    '# M2b vs legacy Airtable Aanbevelingen — parity',
    '',
    `Sample: ${sample.length} trainings present in both the legacy Aanbevelingen snapshot and the current Monday board.`,
    'Travel is stubbed (eligibility is pre-travel); this compares the recommended trainer SETS.',
    '',
    '**Two expected divergences**, both classified automatically below:',
    '',
    '1. *colour-excluded* — M2b is green-only (ITG collapsed the stoplicht on 30 July 2026); legacy',
    '   allowed Oranje. An only-legacy trainer whose legacy `Qualification` was Oranje/Grijs/Rood is',
    '   expected.',
    '2. *requalified* — the legacy row said Groen, but the trainer is NOT effective-green on the live',
    '   board any more. Aanbevelingen is an APPEND-ONLY LOG: rows are never recomputed, so they record',
    '   what was true when written. ITG has been re-qualifying in bulk since 30 July.',
    '',
    'Only a trainer who was green THEN and is still green NOW, yet is missing from our result, is a',
    'genuine only-legacy discrepancy — that is the `unexplained` bucket.',
    '',
    '**`only-M2b` is NOT auto-explained.** Its absence from Airtable proves only that no legacy row',
    'exists, not that legacy would have recommended the trainer but for their colour — legacy may have',
    'omitted them for a group, rate, route or workflow reason, and Airtable does not record WHY anyone',
    'was left out. Treat this bucket as outstanding review, not as expected drift.',
    '',
    '> **NOTE — this file is GENERATED by `pnpm recommend:parity`. Do not hand-edit it;**',
    '> **anything added here is overwritten on the next run.**',
    '',
    '## Investigating a non-colour diff',
    '',
    '**These counts do NOT certify themselves.** The sampled trainings and the live board both change',
    'between runs, so every `unexplained` / `only-M2b` diff in THIS report must be investigated afresh —',
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
    `- only-legacy, requalified since (expected — stale legacy row): **${onlyLegacyRequalified}**`,
    `- only-legacy, green THEN and NOW (REVIEW — genuine discrepancy): **${onlyLegacyUnexplained}**`,
    `- only-M2b (REVIEW — reason unrecoverable from the snapshot): **${onlyM2b}**`,
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
    `\nAggregate → matched ${matched}, oranje-excluded ${onlyLegacyExcluded}, requalified ${onlyLegacyRequalified}, unexplained ${onlyLegacyUnexplained}, only-m2b ${onlyM2b}, fout ${foutCount}, errored ${erroredCount}`
  );
  console.log(`Report → ${REPORT}`);
}

main().catch((error) => {
  console.error('recommend-parity failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
