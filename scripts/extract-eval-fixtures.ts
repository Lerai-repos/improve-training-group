/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv, resolveColumns } from '@lib/evaluations';

/**
 * Build the COMMITTED evaluation fixtures from the gitignored source data.
 *
 * Both corpora — `docs/*.csv` and `snapshots/airtable/*.json` — are gitignored, so any
 * test that reads them directly is skipped on a fresh clone and in CI. That is fine for
 * the exhaustive checks and useless for the one that matters: the roll-up arithmetic is
 * the delivery gate, and a gate that silently does not run is not a gate.
 *
 * So this extracts two small, sanitized, committed fixtures:
 *
 *   1. `responses.sample.csv`  — the reader's traps, in real data: interior blank
 *      blocks, sequence-number timestamps, blank and unparseable grades, a padded short
 *      row, quoted commas and newlines.
 *   2. `tier-a.golden.json`    — a stratified slice of the Airtable roll-up: the inputs
 *      (per-training aggregates + trainer/thema links) and the expected
 *      (weightedAvg, evaluationCount, timesTaught) per pair.
 *
 * SANITISATION: every identifier is replaced by a stable synthetic one and **no name
 * ever leaves the source data**. Airtable's stats rows carry `Name` ("Andrea Rijna -
 * Kernkwadranten"); the CSV rows carry free-text answers. Neither is consumed by any
 * module under test, and both are client data, so both are dropped rather than
 * anonymised. Grades, counts and dates are kept verbatim — those are what is on trial.
 *
 *   pnpm fixtures:eval
 */

const AT_DIR = join(process.cwd(), 'snapshots', 'airtable');
const DOCS_DIR = join(process.cwd(), 'docs');
const OUT_DIR = join(process.cwd(), 'lib', 'evaluations', '__tests__', 'fixtures');

const NL_CSV = '1.0 Individuele Evaluatie - NL (Antwoorden) - Formulierreacties 1.csv';

/** How many pairs the golden slice carries beyond the ones it must include. */
const SAMPLE_PAIRS = 60;

interface Rec {
  id: string;
  fields: Record<string, unknown>;
}

const readAirtable = (name: string): Rec[] =>
  JSON.parse(readFileSync(join(AT_DIR, `${name}.json`), 'utf8'));

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Stable synthetic ids, assigned in first-seen order so the output is deterministic. */
function aliaser(prefix: string): (real: string) => string {
  const seen = new Map<string, string>();
  return (real: string): string => {
    const existing = seen.get(real);
    if (existing !== undefined) {
      return existing;
    }
    const alias = `${prefix}${String(seen.size + 1).padStart(4, '0')}`;
    seen.set(real, alias);
    return alias;
  };
}

/**
 * The five pairs where our roll-up disagrees with Airtable's `Times Given`, each with
 * the cause established by inspection. Every one is Airtable being wrong:
 *   - `stale`: the stats row was last recomputed before a training completed;
 *   - `counts_unfinished`: Flow 9 increments `timesGiven` for the training it is
 *     processing without checking its status (its own docs call this "same-batch status
 *     blindness"), so a 2026-10/11 training already counts.
 */
const KNOWN_TIMES_GIVEN_DIFFS: Record<string, 'stale' | 'counts_unfinished'> = {
  rec1xM6bHhORiT2w2: 'stale',
  recaEFSB3UOBgG8rm: 'stale',
  recx4xBOgnRjarsnY: 'stale',
  recST2raWzgXtHZ7P: 'counts_unfinished',
  receCauH9PDL1Jivp: 'counts_unfinished',
};

function buildTierAGolden(): unknown {
  const trainingen = readAirtable('trainingen');
  const stats = readAirtable('trainer_thema_stats');

  // Pairs Airtable's own completed history produces, and which trainings feed them.
  const contributors = new Map<string, string[]>();
  for (const training of trainingen) {
    if (training.fields.Status !== 'Afgerond') {
      continue;
    }
    for (const trainer of arr(training.fields.Trainer)) {
      for (const thema of arr(training.fields.Thema)) {
        const key = `${trainer}|${thema}`;
        contributors.set(key, [...(contributors.get(key) ?? []), training.id]);
      }
    }
  }

  const statsByPair = new Map(
    stats.map((s) => [`${arr(s.fields.Trainer)[0]}|${arr(s.fields.Thema)[0]}`, s])
  );

  /**
   * Stratify for COVERAGE, not volume.
   *
   * The obvious sort — heaviest pairs first — drags 851 trainings in behind 125 pairs
   * and produces a fixture nobody will read. What the arithmetic needs is one example
   * of each shape, so the buckets below are filled round-robin and every pair is cheap.
   */
  const bucketOf = (key: string): string => {
    const trainings = contributors.get(key)?.length ?? 0;
    const evals = num(statsByPair.get(key)?.fields['Total Evalutions']);
    if (evals === 0) {
      return 'no-evals';
    }
    if (trainings === 1) {
      return 'single';
    }
    return trainings <= 3 ? 'weighted-small' : 'weighted-large';
  };

  const byBucket = new Map<string, string[]>();
  for (const key of [...contributors.keys()].filter((k) => statsByPair.has(k)).sort()) {
    const bucket = bucketOf(key);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), key]);
  }

  const mustHave = [...contributors.keys()].filter((key) => {
    const row = statsByPair.get(key);
    return row !== undefined && row.id in KNOWN_TIMES_GIVEN_DIFFS;
  });

  const picked = new Set(mustHave);
  const buckets = [...byBucket.keys()].sort();
  for (let round = 0; picked.size < SAMPLE_PAIRS; round += 1) {
    let advanced = false;
    for (const bucket of buckets) {
      const key = byBucket.get(bucket)?.[round];
      if (key === undefined) {
        continue;
      }
      advanced = true;
      picked.add(key);
      if (picked.size >= SAMPLE_PAIRS) {
        break;
      }
    }
    if (!advanced) {
      break;
    }
  }
  const chosen = [...picked].sort();

  const trainerAlias = aliaser('trainer-');
  const themaAlias = aliaser('thema-');
  const trainingAlias = aliaser('training-');
  const byId = new Map(trainingen.map((t) => [t.id, t]));

  const neededTrainings = new Set(chosen.flatMap((key) => contributors.get(key) ?? []));

  const trainings = [...neededTrainings]
    .sort()
    .map((id) => {
      const training = byId.get(id);
      if (training === undefined) {
        throw new Error(`training ${id} vanished`);
      }
      const evaluationCount = num(training.fields['Evaluation count']);
      const avg = num(training.fields['Avg Overall grade']);
      return {
        trainingItemId: trainingAlias(id),
        trainerExternalIds: arr(training.fields.Trainer).map(trainerAlias),
        themaExternalIds: arr(training.fields.Thema).map(themaAlias),
        // Airtable stores 0 for "no grade"; our contract is null.
        avgOverallGrade: evaluationCount > 0 && avg > 0 ? avg : null,
        evaluationCount,
      };
    });

  const expected = chosen.map((key) => {
    const [trainer, thema] = key.split('|');
    const row = statsByPair.get(key);
    if (row === undefined) {
      throw new Error(`no Airtable row for ${key}`);
    }
    const weightedAvg = num(row.fields['Weighted Avg']);
    return {
      trainerExternalId: trainerAlias(trainer),
      themaExternalId: themaAlias(thema),
      // Airtable's 0 is our null: it has no way to say "no evaluations".
      weightedAvg: weightedAvg === 0 ? null : weightedAvg,
      evaluationCount: num(row.fields['Total Evalutions']),
      timesTaught: num(row.fields['Times Given']),
      knownDiff: KNOWN_TIMES_GIVEN_DIFFS[row.id] ?? null,
    };
  });

  return {
    _note:
      'Generated by scripts/extract-eval-fixtures.ts from the gitignored Airtable ' +
      'snapshot. Ids are synthetic; no names are carried. Grades, counts and the ' +
      'known-diff classifications are verbatim. Regenerate only with a fresh snapshot, ' +
      'and explain any moved number.',
    trainings,
    expected,
  };
}

/** Serialize one cell, quoting only when it must be. */
function toCsvCell(value: string): string {
  return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Rows the reader must survive, lifted from the real NL export.
 *
 * PARSED, not line-sliced. The free-text answers contain embedded newlines, so slicing
 * the file by lines cuts records in half and yields a fixture with an odd number of
 * quotes — malformed input masquerading as a regression corpus.
 *
 * The two free-text columns are BLANKED. They are real participant prose, they are the
 * only genuinely sensitive content in the export, and no module under test reads them.
 * Everything the reader is judged on — codes, grades, timestamps, blank rows, row
 * geometry — is kept verbatim.
 */
function buildResponsesSample(): string {
  const path = join(DOCS_DIR, NL_CSV);
  if (!existsSync(path)) {
    throw new Error(`missing ${path} — the NL export is gitignored; run this locally`);
  }
  const grid = parseCsv(readFileSync(path, 'utf8'));
  const [header, ...rows] = grid;

  /**
   * ALLOWLIST, not a blocklist. Naming the two obviously-prose columns was not enough:
   * the follow-up question is nominally Ja/Nee and participants type sentences into it
   * ("Yes but it's not up to me :("). Anything outside the columns the reader actually
   * consumes — plus the five numeric sub-scores, which keep the row geometry honest —
   * is blanked, so a column added or reordered upstream cannot leak prose by default.
   */
  const resolution = resolveColumns(header);
  if (!resolution.ok) {
    throw new Error(`cannot resolve the NL header: ${resolution.reason}`);
  }
  const SUB_SCORE_COLUMNS = [2, 3, 4, 5, 6];
  const keep = new Set<number>([
    resolution.columns.code,
    resolution.columns.grade,
    ...(resolution.columns.timestamp === null ? [] : [resolution.columns.timestamp]),
    ...SUB_SCORE_COLUMNS,
  ]);
  const redact = (row: readonly string[]): string[] =>
    row.map((cell, index) => (keep.has(index) ? cell : ''));

  const isBlank = (row: readonly string[]): boolean => !row.some((c) => c.trim() !== '');
  const lastBlank = rows.reduce((last, row, i) => (isBlank(row) ? i : last), -1);
  const firstBlankOfRun = (() => {
    let i = lastBlank;
    while (i > 0 && isBlank(rows[i - 1])) {
      i -= 1;
    }
    return i;
  })();

  // A window spanning the final interior blank run: a few real rows, the blank run
  // itself (trimmed), and every real row that follows it. A reader that stops at the
  // first blank row loses that tail — which is the trap this fixture exists to pin.
  const BLANK_ROWS_KEPT = 4;
  const REAL_ROWS_BEFORE = 6;
  const window = [
    ...rows.slice(Math.max(0, firstBlankOfRun - REAL_ROWS_BEFORE), firstBlankOfRun),
    ...rows.slice(firstBlankOfRun, firstBlankOfRun + BLANK_ROWS_KEPT),
    ...rows.slice(lastBlank + 1),
  ];

  return `${[header, ...window.map(redact)].map((row) => row.map(toCsvCell).join(',')).join('\n')}\n`;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const golden = buildTierAGolden();
  writeFileSync(join(OUT_DIR, 'tier-a.golden.json'), `${JSON.stringify(golden, null, 2)}\n`, {
    mode: 0o644,
  });
  console.log('wrote tier-a.golden.json');

  writeFileSync(join(OUT_DIR, 'responses.sample.csv'), buildResponsesSample(), { mode: 0o644 });
  console.log('wrote responses.sample.csv');
}

main();
