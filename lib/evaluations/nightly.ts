/**
 * The nightly job: sheets → attribution → Agenda history → qualifications → one Redis
 * record.
 *
 * Everything here is injected, so the guards can be tested without a network. The route
 * is a thin caller — see `app/api/cron/eval-stats/route.ts`.
 *
 * WHY THE GUARDS EXIST. The engine reads this record live and treats an absent pair as
 * "this trainer has never taught this theme". So a run that quietly produces fewer rows
 * than it should does not degrade the data — it manufactures confident false statements
 * about real people, across the whole board, until the next good run. Every refusal
 * below is a case where writing would be worse than not writing.
 */

import { checkSourceDrop } from '@lib/monday/schema-check';

import { attributeResponses } from './attribute';
import { amsterdamToday, computeTrainerThemaStats } from './stats';

import type { Anomaly } from '@lib/monday/validate';
import type { AttributionReport } from './attribute';
import type { AgendaHistory } from './agenda-history';
import type { EvaluationSource, SheetReadSummary } from './sheets-reader';
import type { StatsReport } from './stats';
import type { StatsSnapshot, StatsStore } from './stats-store';
import type { QualificationColour, QualificationObservation, TrainerThemaStatRow } from './types';

/**
 * Absolute floors, for the run that has no previous snapshot to compare against.
 *
 * Measured live on 12-Aug-2026: 3.713 responses, 2.191 rows. These sit near half of
 * that — low enough that legitimate change never trips them, high enough that a
 * collapsed source cannot be written as the first record. Crude on purpose: a floor
 * needs no state and cannot itself fail.
 */
export const MIN_RESPONSES = 1_800;
export const MIN_ROWS = 1_000;

/**
 * How far a per-source count may fall overnight before the run refuses.
 *
 * `0.9`, not the library default of `0.5`. These counts accumulate — responses are never
 * withdrawn, trainings are rarely deleted — so a 10% overnight drop is already abnormal,
 * while 50% would wave through the loss of an entire document. Losing the English sheet
 * is 235 of 3.713 responses: invisible in the total, unmissable in `sheet:en`, which is
 * why the counts are per document.
 */
export const DROP_FACTOR = 0.9;

export type RefusalReason = 'source_floor' | 'row_floor' | 'source_drop' | 'no_baseline';

export interface NightlyDeps {
  source: EvaluationSource;
  readHistory: () => Promise<AgendaHistory>;
  readQualifications: () => Promise<readonly QualificationColour[]>;
  store: StatsStore;
  now: () => Date;
}

export interface NightlyOptions {
  /** Compute and report, write nothing. */
  dryRun?: boolean;
  /** Override a refusal the operator has looked at and accepted. */
  force?: boolean;
  /**
   * Create the FIRST record, when there is no previous one to compare against.
   *
   * Separate from `force` because it is a different decision. Without a baseline the
   * drop guard cannot run at all, so a first run that is missing an entire smaller
   * source — losing `sheet:en` costs 235 of 3.713 responses, ~6% — sails past the global
   * floors, gets published, and becomes the baseline every later night is measured
   * against. The collapse is then permanent and invisible.
   *
   * So the cron never bootstraps. A human does, from the parity-gated seed, having
   * looked at the numbers.
   */
  bootstrap?: boolean;
}

export interface NightlyReport {
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly refused: RefusalReason | null;
  readonly detail: string | null;
  readonly today: string;
  readonly sources: Record<string, number>;
  readonly rows: number;
  readonly rowsWithEvaluations: number;
  readonly rowsQualificationOnly: number;
  readonly bytes: number;
  readonly attribution: AttributionReport;
  readonly stats: StatsReport;
  /** Per-document read summaries, so the report can be rendered without reading again. */
  readonly sheets: readonly SheetReadSummary[];
  /** Distinct (trainer, thema) pairs observed on the Thema's board. */
  readonly qualificationPairs: number;
  readonly perBoard: AgendaHistory['perBoard'];
  /** Previous record's age in whole hours, or null on the very first run. */
  readonly previousAgeHours: number | null;
}

/** One number per source, plus the derived totals the drop check compares. */
function sourceCounts(input: {
  sheets: ReadonlyArray<{ label: string; responses: number }>;
  history: AgendaHistory;
  rows: readonly TrainerThemaStatRow[];
  attributed: number;
}): Record<string, number> {
  const counts: Record<string, number> = {
    'responses:total': input.sheets.reduce((sum, sheet) => sum + sheet.responses, 0),
    'responses:attributed': input.attributed,
    'rows:total': input.rows.length,
  };
  for (const sheet of input.sheets) {
    counts[`sheet:${sheet.label}`] = sheet.responses;
  }
  for (const board of input.history.perBoard) {
    counts[`trainings:${board.jaargang}`] = board.items;
  }
  return counts;
}

function floorRefusal(
  counts: Record<string, number>,
  rows: number
): { reason: RefusalReason; detail: string } | null {
  const responses = counts['responses:total'] ?? 0;
  if (responses < MIN_RESPONSES) {
    return {
      reason: 'source_floor',
      detail: `only ${responses} responses across all documents, below the floor of ${MIN_RESPONSES}`,
    };
  }
  if (rows < MIN_ROWS) {
    return {
      reason: 'row_floor',
      detail: `only ${rows} trainer×thema rows, below the floor of ${MIN_ROWS}`,
    };
  }
  return null;
}

function dropRefusal(
  counts: Record<string, number>,
  previous: StatsSnapshot | null,
  bootstrap: boolean
): { reason: RefusalReason; detail: string } | null {
  if (previous === null) {
    return bootstrap
      ? null
      : {
          reason: 'no_baseline',
          detail:
            'no previous snapshot to compare against, so the per-source drop guard cannot ' +
            'run — refusing to publish an unverified first record. Seed it deliberately ' +
            '(`pnpm eval:dryrun --apply`), which is parity-gated.',
        };
  }

  /**
   * A key that VANISHED counts as zero.
   *
   * `checkSourceDrop` walks the previous keys and skips any whose current value is not a
   * number — so dropping `sheet:en` from the document list, or renaming it, removes the
   * key entirely and evades the per-document guard completely, while the ~6% dent in the
   * total stays under any sane global threshold. Materialising the absence as `0` is what
   * makes "the English sheet disappeared" indistinguishable from "the English sheet
   * returned nothing", which is the intent.
   */
  const withMissingAsZero: Record<string, number> = { ...counts };
  for (const key of Object.keys(previous.sources)) {
    withMissingAsZero[key] ??= 0;
  }

  const anomaly: Anomaly | null = checkSourceDrop(
    withMissingAsZero,
    previous.sources,
    {},
    DROP_FACTOR
  );
  if (anomaly === null || anomaly.severity !== 'fatal') {
    return null;
  }
  return { reason: 'source_drop', detail: anomaly.detail };
}

const HOUR_MS = 60 * 60 * 1000;

/** A computed, judged run — everything except the write. */
export interface PreparedNightly {
  readonly report: NightlyReport;
  readonly rows: readonly TrainerThemaStatRow[];
  readonly writtenAt: string;
  /** Whether {@link commitNightly} would write; false when refused or in a dry run. */
  readonly writable: boolean;
}

/**
 * Compute and judge, without writing.
 *
 * Split from the write so a caller can publish EXACTLY what it showed a human. Running
 * the whole chain twice — once to report, once to write — republishes a second, unseen
 * dataset, and any change between the two reads means the reviewed numbers are not the
 * ones that went live.
 */
export async function prepareNightly(
  deps: NightlyDeps,
  options: NightlyOptions = {}
): Promise<PreparedNightly> {
  const dryRun = options.dryRun === true;
  const now = deps.now();
  const today = amsterdamToday(now);

  // All three reads before anything is judged: each throws on its own failure, and a
  // partial view is exactly what the guards below cannot distinguish from a real change.
  const [{ responses, sheets }, history, observations] = await Promise.all([
    deps.source.readResponses(),
    deps.readHistory(),
    deps.readQualifications(),
  ]);

  const byPair = new Map<string, QualificationObservation>();
  for (const observation of observations) {
    const key = `${observation.trainerExternalId}|${observation.themaExternalId}`;
    const existing = byPair.get(key);
    byPair.set(key, {
      trainerExternalId: observation.trainerExternalId,
      themaExternalId: observation.themaExternalId,
      colours: [...(existing?.colours ?? []), observation.colour],
    });
  }

  const { aggregates, report: attribution } = attributeResponses(
    responses,
    history.trainings.map((training) => training.ref)
  );
  const { rows, report: stats } = computeTrainerThemaStats({
    history: history.trainings.map((training) => training.entry),
    aggregates,
    qualifications: [...byPair.values()],
    today,
  });

  const previous = await deps.store.read();
  const counts = sourceCounts({
    sheets: sheets.map((sheet) => ({ label: sheet.source.label, responses: sheet.responses })),
    history,
    rows,
    attributed: attribution.attributedResponses,
  });

  const refusal =
    floorRefusal(counts, rows.length) ??
    dropRefusal(counts, previous, options.bootstrap === true);

  /**
   * `force` covers a floor or drop the operator has looked at and accepted. It does NOT
   * cover `no_baseline`, which is a different decision: without a previous snapshot the
   * drop guard cannot run AT ALL, so forcing past it publishes a completely unverified
   * first record and enshrines it as the baseline every later night is measured against.
   * Creating the first record requires `bootstrap`, which only the parity-gated seed
   * passes — otherwise `?force=1` on the cron URL quietly becomes the bootstrap flow.
   */
  const overridden =
    refusal !== null && refusal.reason !== 'no_baseline' && options.force === true;

  const base = {
    dryRun,
    today,
    sources: counts,
    rows: rows.length,
    rowsWithEvaluations: rows.filter((row) => row.evaluationCount > 0).length,
    rowsQualificationOnly: stats.rowsFromQualificationOnly,
    bytes: deps.store.sizeOf(rows),
    attribution,
    stats,
    sheets,
    qualificationPairs: byPair.size,
    perBoard: history.perBoard,
    previousAgeHours:
      previous === null
        ? null
        : Math.floor((now.getTime() - Date.parse(previous.writtenAt)) / HOUR_MS),
  };

  const writtenAt = now.toISOString();

  if (refusal !== null && !overridden) {
    // The previous record is left exactly as it was. Stale statistics are a known,
    // visible state; wrong ones are not.
    return {
      report: { ...base, written: false, refused: refusal.reason, detail: refusal.detail },
      rows,
      writtenAt,
      writable: false,
    };
  }

  const detail = overridden
    ? `${dryRun ? 'would have refused' : 'forced past'}: ${refusal?.detail ?? ''}`
    : null;

  return {
    report: { ...base, written: !dryRun, refused: null, detail },
    rows,
    writtenAt,
    writable: !dryRun,
  };
}

/**
 * Publish exactly the prepared dataset.
 *
 * Returns the report unchanged when the run was refused or was a dry run, so a caller
 * can always call this and let the decision live in one place.
 */
export async function commitNightly(
  deps: NightlyDeps,
  prepared: PreparedNightly
): Promise<NightlyReport> {
  if (!prepared.writable) {
    return prepared.report;
  }
  await deps.store.write({
    rows: prepared.rows,
    writtenAt: prepared.writtenAt,
    today: prepared.report.today,
    // Written together with the data they describe, so the baseline can never advance
    // on its own and a refused run cannot half-update it.
    sources: prepared.report.sources,
  });
  return prepared.report;
}

/** Prepare and commit in one step — what the cron does. */
export async function runNightly(
  deps: NightlyDeps,
  options: NightlyOptions = {}
): Promise<NightlyReport> {
  return commitNightly(deps, await prepareNightly(deps, options));
}
