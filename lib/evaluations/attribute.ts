/**
 * The IE-code join: responses × trainings → one aggregate per training, plus a ledger
 * of everything that did not make it.
 *
 * Pure. The losses are the point as much as the aggregates: ITG's codes are entered by
 * participants, so a meaningful slice never attributes, and the spec's contract is that
 * those are **counted and reportable, never silent**. The invariant that keeps that
 * honest is asserted in the tests:
 *
 *     attributedResponses + Σ losses[].responseCount === totalResponses
 */

import { round2 } from '@lib/calc';

import type { EvaluationResponse, SheetRef, TrainingAggregate, TrainingRef } from './types';

export type LossKind =
  /** Two or more trainings claim this code, so it belongs to none of them. */
  | 'ambiguous_code'
  /** No training claims it: a typo, or junk like 'Carlijn', 'XXX', '-'. */
  | 'unknown_code'
  /** The respondent left the field empty. */
  | 'blank_code'
  /** No exact match, but exactly one match ignoring case. Reported, not attributed. */
  | 'case_only_miss';

export interface ResponseRef {
  readonly source: SheetRef;
  readonly rowNumber: number;
}

export interface ResponseLoss {
  readonly kind: LossKind;
  readonly code: string;
  readonly responseCount: number;
  /** For `ambiguous_code` / `case_only_miss`: which trainings claim it. */
  readonly candidateTrainingIds: readonly string[];
  /**
   * For `ambiguous_code`: how many distinct clients are among the candidates. `1` means
   * one client reused a code across a series, which is a different conversation with
   * ITG than two unrelated clients colliding.
   *
   * **`null` means UNKNOWN**, and is what you get when the trainings carry no
   * `clientKey`. It is not the same as "several": falling back to the training id would
   * make every candidate its own client and report every collision as cross-client,
   * which is precisely the number someone would act on.
   */
  readonly distinctClients: number | null;
  /** Capped, so a 300-response bucket does not become a log dump. */
  readonly sampleRows: readonly ResponseRef[];
}

export interface AttributionReport {
  readonly totalResponses: number;
  readonly attributedResponses: number;
  readonly losses: readonly ResponseLoss[];
  readonly trainingsTotal: number;
  readonly trainingsWithoutCode: number;
  readonly trainingsWithoutResponses: number;
  readonly trainingsWithAmbiguousCode: readonly string[];
  readonly duplicateCodesOnTraining: readonly string[];
}

export interface AttributionResult {
  readonly aggregates: readonly TrainingAggregate[];
  readonly report: AttributionReport;
}

/** How many example rows a loss bucket carries. */
export const MAX_LOSS_SAMPLES = 5;

/**
 * Legacy Flow 9 matches with `String(x).trim()` on both sides — **case-sensitive**.
 *
 * Kept case-sensitive on purpose. Folding recovers 12 of 3.207 responses (0,37%) across
 * 10 code groups and creates 2 new ambiguous attributions, while injecting 12 deviations
 * into a parity gate whose whole job is that every difference from Airtable is
 * explainable. The near-misses are not lost silently: they land in `case_only_miss` with
 * their candidates, so ITG can fix the source data they own. Once the gate is green this
 * is a one-line change with a counter proving exactly which responses moved.
 */
export function normalizeCode(raw: string): string {
  return raw.trim();
}

/**
 * Split a training's IE-code cell on the literal `', '`, exactly as legacy Flow 4 does.
 *
 * Not a bare comma, not `';'`, not `' en '`. All five multi-code trainings in the corpus
 * use `', '`, and widening the separator changes what a code *is* — that needs its own
 * measurement, not a guess.
 */
export function splitIeCodes(rawIeCode: string | null): readonly string[] {
  if (rawIeCode === null) {
    return [];
  }
  return rawIeCode
    .split(', ')
    .map((code) => normalizeCode(code))
    .filter((code) => code !== '');
}

interface Bucket {
  readonly code: string;
  readonly responses: EvaluationResponse[];
}

const refOf = (response: EvaluationResponse): ResponseRef => ({
  source: response.source,
  rowNumber: response.rowNumber,
});

/** The mean of the parseable grades, rounded like Airtable does — at TRAINING level. */
function averageGrade(responses: readonly EvaluationResponse[]): number | null {
  const grades = responses.flatMap((r) => (r.grade === null ? [] : [r.grade]));
  if (grades.length === 0) {
    return null;
  }
  return round2(grades.reduce((sum, g) => sum + g, 0) / grades.length);
}

export function attributeResponses(
  responses: readonly EvaluationResponse[],
  trainings: readonly TrainingRef[]
): AttributionResult {
  // 1. Which trainings claim which code.
  const codeIndex = new Map<string, string[]>();
  const foldedIndex = new Map<string, Set<string>>();
  const duplicateCodesOnTraining: string[] = [];
  let trainingsWithoutCode = 0;

  for (const training of trainings) {
    const codes = splitIeCodes(training.rawIeCode);
    if (codes.length === 0) {
      trainingsWithoutCode += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const code of codes) {
      if (seen.has(code)) {
        duplicateCodesOnTraining.push(training.trainingItemId);
        continue;
      }
      seen.add(code);
      const claimants = codeIndex.get(code) ?? [];
      claimants.push(training.trainingItemId);
      codeIndex.set(code, claimants);

      const folded = code.toLowerCase();
      const foldedCandidates = foldedIndex.get(folded) ?? new Set<string>();
      foldedCandidates.add(code);
      foldedIndex.set(folded, foldedCandidates);
    }
  }

  const clientOf = new Map(trainings.map((t) => [t.trainingItemId, t.clientKey]));

  // 2. Group the responses by their normalized code.
  const buckets = new Map<string, Bucket>();
  for (const response of responses) {
    const code = normalizeCode(response.rawCode);
    const bucket = buckets.get(code) ?? { code, responses: [] };
    bucket.responses.push(response);
    buckets.set(code, bucket);
  }

  // 3. Attribute, or record a named loss. Every response ends in exactly one place.
  const matched = new Map<string, { responses: EvaluationResponse[]; codes: Set<string> }>();
  const losses: ResponseLoss[] = [];
  let attributedResponses = 0;

  const loss = (
    kind: LossKind,
    bucket: Bucket,
    candidateTrainingIds: readonly string[],
    distinctClients: number | null
  ): void => {
    losses.push({
      kind,
      code: bucket.code,
      responseCount: bucket.responses.length,
      candidateTrainingIds,
      distinctClients,
      sampleRows: bucket.responses.slice(0, MAX_LOSS_SAMPLES).map(refOf),
    });
  };

  for (const bucket of buckets.values()) {
    if (bucket.code === '') {
      loss('blank_code', bucket, [], null);
      continue;
    }

    const claimants = codeIndex.get(bucket.code);
    if (claimants === undefined) {
      // No exact claimant. Is there exactly one that differs only in case? That is a
      // reportable near-miss, NOT an attribution.
      const foldedCandidates = foldedIndex.get(bucket.code.toLowerCase());
      if (foldedCandidates !== undefined && foldedCandidates.size === 1) {
        const [onlyCode] = [...foldedCandidates];
        loss('case_only_miss', bucket, codeIndex.get(onlyCode) ?? [], null);
      } else {
        loss('unknown_code', bucket, [], null);
      }
      continue;
    }

    if (claimants.length > 1) {
      // Only classify when we actually know who the clients are. With no client key the
      // honest answer is "unknown", not a count derived from training ids.
      const keys = claimants.map((id) => clientOf.get(id) ?? null);
      const known = keys.filter((key): key is string => key !== null);
      loss(
        'ambiguous_code',
        bucket,
        claimants,
        known.length === claimants.length ? new Set(known).size : null
      );
      continue;
    }

    const trainingItemId = claimants[0];
    const entry = matched.get(trainingItemId) ?? { responses: [], codes: new Set<string>() };
    entry.responses.push(...bucket.responses);
    entry.codes.add(bucket.code);
    matched.set(trainingItemId, entry);
    attributedResponses += bucket.responses.length;
  }

  // 4. One aggregate per training that actually received responses. A zero-response
  //    training reaches `stats.ts` through the Agenda history instead, which makes
  //    `evaluationCount === 0` unconstructible here by accident.
  const aggregates: TrainingAggregate[] = [...matched.entries()]
    .map(([trainingItemId, entry]) => ({
      trainingItemId,
      // Legacy counts matched ROWS, blank grades included, while the average skips
      // them. Verified on training 251010: 25 rows, 24 grades, 8.33 on both sides.
      avgOverallGrade: averageGrade(entry.responses),
      evaluationCount: entry.responses.length,
      matchedCodes: [...entry.codes].sort(),
    }))
    // Deterministic: the dry-run diff is read by a human.
    .sort((a, b) => a.trainingItemId.localeCompare(b.trainingItemId));

  const ambiguousTrainingIds = new Set(
    losses.filter((l) => l.kind === 'ambiguous_code').flatMap((l) => l.candidateTrainingIds)
  );

  return {
    aggregates,
    report: {
      totalResponses: responses.length,
      attributedResponses,
      losses: [...losses].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code)),
      trainingsTotal: trainings.length,
      trainingsWithoutCode,
      trainingsWithoutResponses: trainings.length - matched.size,
      trainingsWithAmbiguousCode: [...ambiguousTrainingIds].sort(),
      duplicateCodesOnTraining: [...new Set(duplicateCodesOnTraining)].sort(),
    },
  };
}
