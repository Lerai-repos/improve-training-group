/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  billableHours,
  round2,
  totalCostCents,
  trainerOverallAvg,
  trainingFeeCents,
  travelTimeCompensation,
  weightedThemeAvg,
  type ThemeStat,
  type TrainingEval,
} from '@lib/calc';

/**
 * Parity check: run the new calc engine against the REAL Airtable snapshot and
 * diff against Airtable's stored computed outputs. Settles rounding / null-vs-0
 * against ground truth, not fixtures. Reads gitignored snapshots/ (run
 * `pnpm snapshot:airtable` first).
 *
 * PARTIAL gate — covers: billable hours, weighted theme avg, no-eval null
 * contract, trainer overall avg, travel-time compensation, and total-cost
 * composition (fee + travel + time). NOT covered (inputs not in the snapshot):
 *   - per-km travel cost/charge — Google Maps km/min are computed at runtime and
 *     not persisted, only the resulting costs are;
 *   - recommendation ranking order — Airtable does not store the sort order.
 * Those are validated when the live Monday/Maps integration is built.
 */

const SNAP_DIR = join(process.cwd(), 'snapshots', 'airtable');
const TOLERANCE = 0.01; // 2 decimals
const ONE_CENT = 1;
const MINUTE_ROUNDING_CENTS = 100; // ±€1 tolerance for integer-rounded stored minutes
const CENTS_PER_EURO = 100;
const TRAVEL_TIME_CFG = {
  thresholdMinutes: 90,
  mode: 'per_minute' as const,
  feePerMinuteCents: 100,
};

const recordSchema = z.object({
  id: z.string(),
  fields: z.record(z.unknown()),
});
type Record = z.infer<typeof recordSchema>;

function load(name: string): Record[] {
  const raw = JSON.parse(readFileSync(join(SNAP_DIR, `${name}.json`), 'utf8'));
  return z.array(recordSchema).parse(raw);
}

function num(fields: Record['fields'], key: string): number | null {
  const value = fields[key];
  return typeof value === 'number' ? value : null;
}

/** Airtable lookups arrive as single-element arrays; read the first as a number. */
function firstNum(fields: Record['fields'], key: string): number | null {
  const value = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function linkIds(fields: Record['fields'], key: string): string[] {
  const value = fields[key];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function eurToCents(eur: number): number {
  return Math.round(eur * CENTS_PER_EURO);
}

interface CheckResult {
  name: string;
  checked: number;
  matched: number;
  mismatches: string[];
}

function report(r: CheckResult): void {
  const failed = r.checked - r.matched;
  console.log(
    `\n${r.name}: ${r.matched}/${r.checked} match` + (failed > 0 ? `  (${failed} MISMATCH)` : '  ✓')
  );
  for (const line of r.mismatches.slice(0, 10)) {
    console.log(`  - ${line}`);
  }
  if (r.mismatches.length > 10) {
    console.log(`  … and ${r.mismatches.length - 10} more`);
  }
}

// --- Check 1: billable hours (Duur facturatie) ------------------------------
function checkBillableHours(trainings: Record[]): CheckResult {
  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const t of trainings) {
    const duur = num(t.fields, 'Duur training');
    const expected = num(t.fields, 'Duur facturatie');
    if (duur === null || expected === null) {
      continue;
    }
    checked += 1;
    const got = round2(billableHours(duur));
    if (Math.abs(got - round2(expected)) <= TOLERANCE) {
      matched += 1;
    } else {
      mismatches.push(`${t.id}: duur=${duur} expected=${expected} got=${got}`);
    }
  }
  return { name: 'Billable hours (Duur facturatie)', checked, matched, mismatches };
}

function buildEvalMap(trainings: Record[]): Map<string, TrainingEval> {
  const map = new Map<string, TrainingEval>();
  for (const t of trainings) {
    map.set(t.id, {
      avgOverallGrade: num(t.fields, 'Avg Overall grade'),
      evaluationCount: num(t.fields, 'Evaluation count') ?? 0,
    });
  }
  return map;
}

function reconstruct(evalByTraining: Map<string, TrainingEval>, stat: Record): number | null {
  const evals = linkIds(stat.fields, 'Trainingen')
    .map((id) => evalByTraining.get(id))
    .filter((e): e is TrainingEval => e !== undefined);
  return weightedThemeAvg(evals);
}

// --- Check 2: weighted theme average (rows WITH evaluations) ----------------
function checkWeightedThemeAvg(
  evalByTraining: Map<string, TrainingEval>,
  stats: Record[]
): CheckResult {
  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const s of stats) {
    const totalEvals = num(s.fields, 'Total Evalutions') ?? 0;
    if (totalEvals <= 0) {
      continue;
    }
    const expected = num(s.fields, 'Weighted Avg');
    if (expected === null) {
      continue;
    }
    checked += 1;
    const got = reconstruct(evalByTraining, s);

    if (got !== null && Math.abs(got - round2(expected)) <= TOLERANCE) {
      matched += 1;
    } else {
      mismatches.push(`${s.id}: totalEvals=${totalEvals} expected=${expected} got=${got}`);
    }
  }
  return { name: 'Weighted theme average (with evals)', checked, matched, mismatches };
}

// --- Check 3: null-vs-0 contract (rows WITHOUT evaluations) -----------------
// Engine must return null; Airtable stores 0 (its "no data" value). We assert
// BOTH — engine null AND Airtable in {0, absent} — so an unexpected non-zero
// Airtable value is caught rather than silently passing.
function checkNoEvalNull(evalByTraining: Map<string, TrainingEval>, stats: Record[]): CheckResult {
  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const s of stats) {
    const totalEvals = num(s.fields, 'Total Evalutions') ?? 0;
    if (totalEvals > 0) {
      continue;
    }
    checked += 1;
    const got = reconstruct(evalByTraining, s);
    const airtable = num(s.fields, 'Weighted Avg');
    const airtableIsNoData = airtable === null || airtable === 0;
    if (got === null && airtableIsNoData) {
      matched += 1;
    } else {
      mismatches.push(
        `${s.id}: engine=${got} airtable=${airtable} (want engine null & airtable 0)`
      );
    }
  }
  return {
    name: 'No-eval null contract (engine null / Airtable 0)',
    checked,
    matched,
    mismatches,
  };
}

// --- Check 4: trainer overall average ---------------------------------------
function checkTrainerOverall(stats: Record[], trainers: Record[]): CheckResult {
  const byTrainer = new Map<string, ThemeStat[]>();
  for (const s of stats) {
    const stat: ThemeStat = {
      weightedAvg: num(s.fields, 'Weighted Avg'),
      totalEvaluations: num(s.fields, 'Total Evalutions') ?? 0,
    };
    for (const trainerId of linkIds(s.fields, 'Trainer')) {
      byTrainer.set(trainerId, [...(byTrainer.get(trainerId) ?? []), stat]);
    }
  }

  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const t of trainers) {
    const expected = num(t.fields, 'Overall Avg Score');
    if (expected === null) {
      continue;
    }
    checked += 1;
    const got = trainerOverallAvg(byTrainer.get(t.id) ?? []);
    if (Math.abs(got - expected) <= TOLERANCE) {
      matched += 1;
    } else {
      mismatches.push(`${t.id}: expected=${expected} got=${got}`);
    }
  }
  return { name: 'Trainer overall average', checked, matched, mismatches };
}

// --- Check 5: travel-time compensation (Aanbevelingen) ----------------------
function checkTravelTimeComp(aanbevelingen: Record[]): CheckResult {
  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const a of aanbevelingen) {
    const minutes = num(a.fields, 'Travel Time (min)');
    const expectedEur = num(a.fields, 'Travel Time Compensation');
    if (minutes === null || expectedEur === null) {
      continue;
    }
    checked += 1;
    const got = travelTimeCompensation(minutes, TRAVEL_TIME_CFG);
    // The stored minutes are integer-rounded while the live comp used fractional
    // minutes, so allow ±€1. This confirms the FORMULA (×€1/min over 90) — a
    // ×hourly-rate formula would diverge by €10s, well outside this tolerance.
    if (Math.abs(got - eurToCents(expectedEur)) <= MINUTE_ROUNDING_CENTS) {
      matched += 1;
    } else {
      mismatches.push(`${a.id}: min=${minutes} expected=${expectedEur} got=${got / 100}`);
    }
  }
  return { name: 'Travel-time compensation (×€1/min, ±rounding)', checked, matched, mismatches };
}

// --- Check 6: total-cost composition (Aanbevelingen) ------------------------
// Validates trainingFee = Duration × rate and total = fee + travel + comp.
// `Duration` is ALREADY Duur facturatie (billable) — do NOT re-apply
// billableHours. Uses the stored travel cost (km input absent) and the stored
// comp (its own ±rounding is checked separately), isolating the fee + composition.
function checkTotalCost(aanbevelingen: Record[]): CheckResult {
  const mismatches: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const a of aanbevelingen) {
    const duration = firstNum(a.fields, 'Duration');
    const hourlyEur = firstNum(a.fields, 'Hourly Rate');
    const travelTrainerEur = num(a.fields, 'Travel Cost (Trainer)');
    const compEur = num(a.fields, 'Travel Time Compensation');
    const expectedTotalEur = num(a.fields, 'Total Cost');
    if (
      duration === null ||
      hourlyEur === null ||
      travelTrainerEur === null ||
      compEur === null ||
      expectedTotalEur === null
    ) {
      continue;
    }
    checked += 1;
    const fee = trainingFeeCents(duration, eurToCents(hourlyEur));
    const got = totalCostCents({
      trainingFeeCents: fee,
      trainerTravelCostCents: eurToCents(travelTrainerEur),
      travelTimeCompensationCents: eurToCents(compEur),
    });
    if (Math.abs(got - eurToCents(expectedTotalEur)) <= ONE_CENT) {
      matched += 1;
    } else {
      mismatches.push(`${a.id}: expected=${expectedTotalEur} got=${got / 100}`);
    }
  }
  return { name: 'Total-cost composition (fee + travel + comp)', checked, matched, mismatches };
}

function main(): void {
  const trainings = load('trainingen');
  const stats = load('trainer_thema_stats');
  const trainers = load('trainers');
  const aanbevelingen = load('aanbevelingen');
  const evalByTraining = buildEvalMap(trainings);

  console.log(
    `Loaded ${trainings.length} trainings, ${stats.length} stats, ` +
      `${trainers.length} trainers, ${aanbevelingen.length} aanbevelingen`
  );

  const results = [
    checkBillableHours(trainings),
    checkWeightedThemeAvg(evalByTraining, stats),
    checkNoEvalNull(evalByTraining, stats),
    checkTrainerOverall(stats, trainers),
    checkTravelTimeComp(aanbevelingen),
    checkTotalCost(aanbevelingen),
  ];
  results.forEach(report);

  console.log(
    '\nNOT covered by this snapshot: per-km travel cost/charge (Maps km not stored), ' +
      'recommendation ranking order (not persisted).'
  );

  // A check that verified nothing (checked === 0) is a failure, not a pass — it
  // means field names drifted or the snapshot is malformed.
  const empty = results.filter((r) => r.checked === 0);
  const mismatched = results.filter((r) => r.matched < r.checked);
  for (const r of empty) {
    console.log(`\n${r.name}: 0 rows checked — snapshot/field drift?`);
  }

  const ok = empty.length === 0 && mismatched.length === 0;
  console.log(ok ? '\nPARITY (partial gate): covered checks all pass ✓' : '\nPARITY: FAILED ✗');
  process.exit(ok ? 0 : 1);
}

main();
