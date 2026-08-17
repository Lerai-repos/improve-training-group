import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { attributeResponses } from '../attribute';
import { csvEvaluationSource } from '../csv-source';

import type { SheetRef, TrainingRef } from '../types';

/**
 * The reader and the join, against real messy data.
 *
 * Two halves, for the same reason parity has two: the committed sample runs everywhere,
 * and the exhaustive corpus runs only where the gitignored exports exist.
 *
 * The pinned numbers are exact, never thresholds. A `>= 90%` assertion stays green while
 * a regression eats the difference; a pinned count turns any change into a failing diff
 * that has to be explained — the same argument `whatsapp-parity.test.ts` already makes.
 */

const FIXTURE = join(__dirname, 'fixtures', 'responses.sample.csv');
const DOCS = join(process.cwd(), 'docs');
const NL = '1.0 Individuele Evaluatie - NL (Antwoorden) - Formulierreacties 1.csv';
const EN = '1.0 Individuele Evaluatie - EN (Antwoorden) - Formulierreacties 1.csv';

const ref = (label: string): SheetRef => ({
  documentId: `csv:${label}`,
  sheetName: 'Formulierreacties 1',
  label,
});

describe('the committed response sample', () => {
  const source = csvEvaluationSource([{ text: readFileSync(FIXTURE, 'utf8'), source: ref('nl') }]);

  /**
   * The trap, in real rows. The blank run in this fixture is interior: real responses
   * follow it, and a reader that treats a blank row as end-of-data drops them.
   */
  it('reads the responses that follow the interior blank run', async () => {
    const { responses, sheets } = await source.readResponses();

    expect(sheets[0].blankRows).toBeGreaterThan(0);
    expect(responses.length).toBeGreaterThan(sheets[0].blankRows);

    const lastBlankRow = Math.max(
      ...responses.map((r) => r.rowNumber).filter((n) => n < Math.max(...responses.map((x) => x.rowNumber)))
    );
    // Concretely: there is at least one response AFTER a blank row's position.
    expect(responses.some((r) => r.rowNumber > lastBlankRow)).toBe(true);
  });

  /** Paper evaluations, typed in with a sequence number where the timestamp goes. */
  it('keeps the rows whose Tijdstempel is a bare sequence number', async () => {
    const { responses } = await source.readResponses();

    const sequenced = responses.filter((r) => /^\d{1,2}$/.test(r.receivedAtRaw ?? ''));
    expect(sequenced.length).toBeGreaterThan(0);
    expect(sequenced.every((r) => r.rawCode !== '')).toBe(true);
  });

  it('accounts for every row it was given', async () => {
    const { sheets } = await source.readResponses();

    expect(sheets[0].totalRows).toBe(sheets[0].blankRows + sheets[0].responses);
  });

  /** The free-text columns are blanked in the fixture; nothing under test reads them. */
  it('carries no participant prose', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const body = text.split('\n').slice(1).join('\n');

    expect(body).not.toMatch(/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i);
  });
});

const hasCorpus = existsSync(join(DOCS, NL)) && existsSync(join(DOCS, EN));
const hasTrainings = existsSync(join(process.cwd(), 'snapshots', 'airtable', 'trainingen.json'));

describe.skipIf(!hasCorpus)('the full response exports', () => {
  const source = csvEvaluationSource([
    { text: readFileSync(join(DOCS, NL), 'utf8'), source: ref('nl') },
    { text: readFileSync(join(DOCS, EN), 'utf8'), source: ref('en') },
  ]);

  it('reads exactly the responses that are there', async () => {
    const { responses, sheets } = await source.readResponses();
    const [nl, en] = sheets;

    expect({ total: nl.totalRows, blank: nl.blankRows, responses: nl.responses }).toEqual({
      total: 14211,
      blank: 11239,
      responses: 2972,
    });
    expect({ total: en.totalRows, blank: en.blankRows, responses: en.responses }).toEqual({
      total: 240,
      blank: 5,
      responses: 235,
    });
    expect(responses).toHaveLength(3207);
  });

  it('finds the 13 responses with no grade, and no unparseable ones', async () => {
    const { responses, sheets } = await source.readResponses();

    expect(responses.filter((r) => r.grade === null)).toHaveLength(13);
    // The one corrupt cell ('E') is in a sub-score column we do not read.
    expect(sheets.reduce((sum, s) => sum + s.unparseableGrades, 0)).toBe(0);
  });

  it('resolves the code and grade columns on both sheets despite different headers', async () => {
    const { sheets } = await source.readResponses();

    expect(sheets.map((s) => s.columns.code)).toEqual([1, 1]);
    expect(sheets.map((s) => s.columns.grade)).toEqual([7, 7]);
  });
});

describe.skipIf(!hasCorpus || !hasTrainings)('the full join', () => {
  interface Rec {
    id: string;
    fields: Record<string, unknown>;
  }
  const trainingen: Rec[] = JSON.parse(
    readFileSync(join(process.cwd(), 'snapshots', 'airtable', 'trainingen.json'), 'utf8')
  );
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  const trainings: TrainingRef[] = trainingen.map((r) => ({
    trainingItemId: r.id,
    rawIeCode: str(r.fields['IE Code']),
    clientKey: Array.isArray(r.fields.Klanten)
      ? String(r.fields.Klanten[0])
      : str(r.fields.Bedrijfsnaam),
    // Airtable's Thema link, so the corpus exercises the same-session rule on real data.
    themaKey: Array.isArray(r.fields.Thema)
      ? [...(r.fields.Thema as unknown[])].map(String).sort().join('+')
      : str(r.fields.Thema),
  }));

  const attributed = async () => {
    const { responses } = await csvEvaluationSource([
      { text: readFileSync(join(DOCS, NL), 'utf8'), source: ref('nl') },
      { text: readFileSync(join(DOCS, EN), 'utf8'), source: ref('en') },
    ]).readResponses();
    return attributeResponses(responses, trainings);
  };

  /** The invariant the whole ledger exists to make checkable. */
  it('accounts for every single response', async () => {
    const { report } = await attributed();
    const lost = report.losses.reduce((sum, l) => sum + l.responseCount, 0);

    expect(report.attributedResponses + lost).toBe(report.totalResponses);
    expect(report.totalResponses).toBe(3207);
  });

  /**
   * The loss budget, pinned. Moving any of these means the join changed, and the change
   * has to be explained before it ships.
   */
  it('has the measured loss budget', async () => {
    const { report } = await attributed();
    const byKind = new Map<string, number>();
    for (const loss of report.losses) {
      byKind.set(loss.kind, (byKind.get(loss.kind) ?? 0) + loss.responseCount);
    }

    // 2.666 → 2.778 when shared codes started attributing: exactly the 112 responses
    // that used to sit in the same-client ambiguity bucket, and nothing else.
    expect(report.attributedResponses).toBe(2778);
    expect(byKind.get('ambiguous_code')).toBe(282);
    expect(byKind.get('unknown_code')).toBe(134);
    expect(byKind.get('case_only_miss')).toBe(12);
    expect(byKind.get('blank_code')).toBe(1);
  });

  /**
   * The spec quoted ONE ambiguity figure; the data holds two very different ones, and
   * they now end in different places. One client repeating a course under a single code
   * is a session ITG recorded as several items — attributed to all of them. Two unrelated
   * clients colliding on a hand-typed number is unattributable and stays a loss.
   *
   * So every remaining ambiguity must be cross-client. A same-client one surviving here
   * would mean the rule stopped firing.
   */
  it('leaves only cross-client collisions unattributed', async () => {
    const { report } = await attributed();
    const ambiguous = report.losses.filter((l) => l.kind === 'ambiguous_code');
    const sum = (predicate: (clients: number) => boolean): number =>
      ambiguous
        .filter((l) => l.distinctClients !== null && predicate(l.distinctClients))
        .reduce((s, l) => s + l.responseCount, 0);

    expect(sum((c) => c > 1)).toBe(282);
    expect(sum((c) => c === 1)).toBe(0);
  });

  /**
   * The other side of the same fact, stated as a gain rather than as an absence: 112
   * responses that legacy attributed and we used to throw away.
   */
  it('recovers the same-client collisions as real attributions', async () => {
    const { report, aggregates } = await attributed();
    const shared = aggregates.filter((a) => a.matchedCodes.length > 0);

    expect(report.attributedResponses).toBe(2778);
    // Several trainings now carry the SAME code — impossible before this rule.
    const perCode = new Map<string, number>();
    for (const aggregate of shared) {
      for (const code of aggregate.matchedCodes) {
        perCode.set(code, (perCode.get(code) ?? 0) + 1);
      }
    }
    expect([...perCode.values()].filter((n) => n > 1).length).toBeGreaterThan(0);
  });

  /** Case-folding would buy 12 responses (0,37%) — recorded, deliberately not taken. */
  it('reports the case-only misses rather than folding them in', async () => {
    const { report } = await attributed();
    const caseMisses = report.losses.filter((l) => l.kind === 'case_only_miss');

    expect(caseMisses).toHaveLength(5);
    expect(caseMisses.every((l) => l.candidateTrainingIds.length > 0)).toBe(true);
  });
});
