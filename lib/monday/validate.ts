import { z } from 'zod';

import type { Qualification } from '@lib/calc';

import { resolveGroupPolicy } from './board-config';
import type { Diagnostic } from './decode';
import { findAliasCandidates, klantFingerprint, klantIdentityKey } from './klant-key';
import type {
  MondayKlant,
  MondayQualification,
  MondayThema,
  MondayTrainer,
  MondayTraining,
} from './types';

/**
 * Stage-3/4 fail-closed validators. Every deviation is either FATAL or an
 * explicitly-ALLOWED anomaly (with rationale) — never a silent warning. Produces
 * the anomaly list plus the derived klant data + conflict resolutions the
 * artifact needs, so a clean dry-run is provable and a dirty one prints the exact
 * worklist.
 */

export type Severity = 'fatal' | 'allowed';

export interface Anomaly {
  kind: string;
  severity: Severity;
  detail: string;
  ids?: string[];
}

export interface Acknowledgements {
  /**
   * OPTIONAL refinement: trainingExternalId → confirmed company name for a
   * no-Bedrijf item. Absent a mapping the training still imports (klant unset);
   * this only lets the client name a specific one instead of leaving it unlinked.
   */
  noBedrijfKlant: Record<string, string>;
  /** alias fingerprint → merge (collapse to `canonical`) or separate (keep distinct). */
  klantAliases: Record<string, { decision: 'merge' | 'separate'; canonical?: string }>;
  /**
   * OPTIONAL refinement: `trainerExt::themaExt` → a reviewed green/red resolution
   * for a colour conflict, BOUND to the exact observed colour set. Absent a
   * resolution the pair's effective is left NULL (deprecated), not fatal. If the
   * pair's colours later change the old decision no longer matches and effective
   * falls back to NULL — a stale decision can't be silently reused.
   */
  qualConflicts: Record<string, { colours: Qualification[]; effective: 'green' | 'red' }>;
  /** group ids acknowledged as intentionally unmapped (no rate/eligibility yet). */
  acknowledgedGroups: string[];
  /**
   * Run-SPECIFIC source-drop approval: key (a board id OR an artifact section) →
   * the EXPECTED `{from, to}` transition. A drop is allowed only when BOTH the
   * previous total equals `from` AND the current total equals `to`, so the
   * approval is effectively one-shot: if the board recovers (a new, larger
   * baseline) and later falls to the same number, `from` no longer matches and
   * it's fatal again — a bare target number would rubber-stamp that recurrence.
   */
  allowSourceDrop?: Record<string, { from: number; to: number }>;
  /**
   * Explicit acknowledgement to BOOTSTRAP when no prior baseline exists — the
   * EXPECTED current counts (board totals and/or section counts). Bootstrapping is
   * allowed only when the live counts match these exactly, so a stale flag can't
   * silently approve a different (possibly damaged) first run; its use is recorded
   * as an allowed anomaly.
   */
  allowNoBaseline?: Record<string, number>;
}

export const EMPTY_ACK: Acknowledgements = {
  noBedrijfKlant: {},
  klantAliases: {},
  qualConflicts: {},
  acknowledgedGroups: [],
  allowSourceDrop: {},
  allowNoBaseline: {},
};

/**
 * Strict runtime schema for the acknowledgements file. A TS annotation does NOT
 * validate parsed JSON — `"allowSourceDrop": "false"` is truthy, and a mistyped
 * alias decision would read like `separate`. `.strict()` rejects unknown keys
 * (catches typos), and every value type is enforced.
 */
export const acknowledgementsSchema = z
  .object({
    noBedrijfKlant: z.record(z.string()).default({}),
    klantAliases: z
      .record(
        z
          .object({ decision: z.enum(['merge', 'separate']), canonical: z.string().optional() })
          .strict()
      )
      .default({}),
    qualConflicts: z
      .record(
        z
          .object({
            colours: z.array(z.enum(['groen', 'oranje', 'rood', 'grijs'])),
            effective: z.enum(['green', 'red']),
          })
          .strict()
      )
      .default({}),
    acknowledgedGroups: z.array(z.string()).default([]),
    allowSourceDrop: z.record(z.object({ from: z.number(), to: z.number() }).strict()).default({}),
    allowNoBaseline: z.record(z.number()).default({}),
  })
  .strict();

export function parseAcknowledgements(raw: unknown): Acknowledgements {
  return acknowledgementsSchema.parse(raw);
}

export interface ValidationInput {
  trainers: MondayTrainer[];
  themas: MondayThema[];
  trainings: MondayTraining[];
  qualifications: MondayQualification[];
  diagnostics: Diagnostic[];
  ack: Acknowledgements;
}

export interface ValidationResult {
  anomalies: Anomaly[];
  fatalCount: number;
  /** Derived klant masters + training→klant links (external-id based). */
  klanten: MondayKlant[];
  trainingKlant: Array<{ trainingExt: string; klantExt: string }>;
  /** Effective overrides for allowlisted conflicts (`trainerExt::themaExt` → green|red). */
  conflictOverrides: Record<string, 'green' | 'red'>;
}

function fatal(kind: string, detail: string, ids?: string[]): Anomaly {
  return { kind, severity: 'fatal', detail, ids };
}
function allowed(kind: string, detail: string, ids?: string[]): Anomaly {
  return { kind, severity: 'allowed', detail, ids };
}

/**
 * Legacy data-quality noise (a training with no Bedrijf link, a trainer×theme in
 * conflicting colours) is TOLERATED up to a ceiling and recorded as a flagged/
 * allowed anomaly — a read-only import must not block on mess the client will
 * clean up over time. But a SPIKE past the ceiling means something broke upstream
 * (e.g. the Bedrijf mirror emptied en masse, which the record-count drop guard
 * can't see) → it re-escalates to fatal. Ceiling = max(floor, ratio × population).
 * The floor keeps small datasets (mock/seed, early syncs) from tripping.
 */
const ANOMALY_ABS_FLOOR = 25;
const UNLINKED_KLANT_RATIO = 0.1;
const QUAL_CONFLICT_RATIO = 0.05;

function anomalyCeiling(ratio: number, population: number): number {
  return Math.max(ANOMALY_ABS_FLOOR, Math.ceil(ratio * population));
}

export function validateSnapshot(input: ValidationInput): ValidationResult {
  const anomalies: Anomaly[] = [];

  // 1. Raw diagnostics — malformed numbers AND empty required fields are fatal.
  const malformed = input.diagnostics.filter((d) => d.kind === 'malformed_number');
  if (malformed.length > 0) {
    anomalies.push(
      fatal(
        'malformed_value',
        `${malformed.length} malformed number field(s)`,
        malformed.map((d) => d.itemId)
      )
    );
  }
  const emptyRequired = input.diagnostics.filter((d) => d.kind === 'empty_required');
  if (emptyRequired.length > 0) {
    anomalies.push(
      fatal(
        'empty_required',
        `${emptyRequired.length} empty required field(s) (e.g. blank trainer/theme name)`,
        emptyRequired.map((d) => d.itemId)
      )
    );
  }

  // 2. Relationship resolution within the staged pull (empty OK, unresolved fatal).
  const trainerIds = new Set(input.trainers.map((t) => t.externalItemId));
  const themaIds = new Set(input.themas.map((t) => t.externalItemId));
  const orphanTrainerRefs: string[] = [];
  const orphanThemaRefs: string[] = [];
  for (const tr of input.trainings) {
    for (const ext of tr.trainerExternalIds) {
      if (!trainerIds.has(ext)) {
        orphanTrainerRefs.push(`${tr.externalItemId}→trainer ${ext}`);
      }
    }
    for (const ext of tr.themaExternalIds) {
      if (!themaIds.has(ext)) {
        orphanThemaRefs.push(`${tr.externalItemId}→thema ${ext}`);
      }
    }
  }
  if (orphanTrainerRefs.length > 0) {
    anomalies.push(
      fatal('unresolved_trainer_ref', 'training references an absent trainer', orphanTrainerRefs)
    );
  }
  if (orphanThemaRefs.length > 0) {
    anomalies.push(
      fatal('unresolved_thema_ref', 'training references an absent thema', orphanThemaRefs)
    );
  }

  // 3. Klant derivation from the Bedrijf mirror. A missing Bedrijf link is treated
  //    like an empty trainer/theme relation: the training imports with klant UNSET
  //    (no guess from the dirty item name) and is flagged — allowed up to a ceiling,
  //    fatal on a spike. An explicit `noBedrijfKlant` mapping still names it if given.
  const nameByKey = new Map<string, string>();
  const trainingKlant: Array<{ trainingExt: string; klantExt: string }> = [];
  const unlinkedKlant: string[] = [];
  const usedNoBedrijf: string[] = [];
  for (const tr of input.trainings) {
    let name = tr.companyName;
    if (!name) {
      name = input.ack.noBedrijfKlant[tr.externalItemId] ?? null;
      if (!name) {
        unlinkedKlant.push(tr.externalItemId);
        continue;
      }
      usedNoBedrijf.push(tr.externalItemId);
    }
    const key = klantIdentityKey(name);
    if (!key) {
      unlinkedKlant.push(tr.externalItemId);
      continue;
    }
    nameByKey.set(key, name);
    trainingKlant.push({ trainingExt: tr.externalItemId, klantExt: key });
  }
  if (unlinkedKlant.length > 0) {
    const cap = anomalyCeiling(UNLINKED_KLANT_RATIO, input.trainings.length);
    const detail = `training has no Bedrijf link; imported with klant unset (${unlinkedKlant.length}/${input.trainings.length}, ceiling ${cap})`;
    anomalies.push(
      unlinkedKlant.length > cap
        ? fatal(
            'no_bedrijf_klant',
            `trainings without a klant link exceed the ceiling (${unlinkedKlant.length} > ${cap}) — possible mass Bedrijf loss`,
            unlinkedKlant
          )
        : allowed('no_bedrijf_klant', detail, unlinkedKlant)
    );
  }

  // 3b. Alias candidates (fingerprint collisions) — fatal until a merge/separate decision.
  const candidates = findAliasCandidates([...nameByKey.values()]);
  const aliasRemap = new Map<string, string>();
  const appliedAliases: string[] = [];
  for (const c of candidates) {
    const decision = input.ack.klantAliases[c.fingerprint];
    if (!decision) {
      anomalies.push(fatal('klant_alias_undecided', `alias candidate ${c.fingerprint}`, c.keys));
      continue;
    }
    appliedAliases.push(`${c.fingerprint}=${decision.decision}`);
    if (decision.decision === 'merge') {
      const canonical = decision.canonical ?? c.keys[0];
      for (const k of c.keys) {
        aliasRemap.set(k, canonical);
      }
      nameByKey.set(canonical, nameByKey.get(canonical) ?? nameByKey.get(c.keys[0]) ?? canonical);
    }
  }
  const remap = (key: string): string => aliasRemap.get(key) ?? key;

  const klanten: MondayKlant[] = [...nameByKey.entries()]
    .filter(([key]) => !aliasRemap.has(key) || aliasRemap.get(key) === key)
    .map(([externalItemId, klantnaam]) => ({ externalItemId, klantnaam }));
  const remappedLinks = trainingKlant.map((l) => ({
    trainingExt: l.trainingExt,
    klantExt: remap(l.klantExt),
  }));

  // 4. Observed-group coverage. An unmapped group never blocks ingestion — the
  //    trainer is always imported with its raw group; the group only lacks a
  //    rate/eligibility policy DOWNSTREAM (M2b). So it is a flagged/allowed anomaly,
  //    not fatal; an explicit `acknowledgedGroups` entry just records that the
  //    client has seen it (stronger provenance in the manifest).
  const unacknowledgedGroups = new Set<string>();
  const acknowledgedUnmapped = new Set<string>();
  for (const t of input.trainers) {
    const group = t.mondayGroup;
    if (!group || resolveGroupPolicy(group)) {
      continue;
    }
    if (input.ack.acknowledgedGroups.includes(group)) {
      acknowledgedUnmapped.add(group);
    } else {
      unacknowledgedGroups.add(group);
    }
  }
  if (unacknowledgedGroups.size > 0) {
    anomalies.push(
      allowed(
        'unmapped_group',
        'trainer group has no rate/eligibility policy (imported; rate unset downstream)',
        [...unacknowledgedGroups]
      )
    );
  }
  if (acknowledgedUnmapped.size > 0) {
    anomalies.push(
      allowed('acknowledged_unmapped_group', 'unmapped group acknowledged (imported, no rate)', [
        ...acknowledgedUnmapped,
      ])
    );
  }

  // 5. Qualification colour conflicts — fatal until allowlisted with an effective
  //    value. Also resolve every qualification ref against the staged masters
  //    (an absent trainer/thema here would otherwise fail only inside the RPC).
  const orphanQualRefs: string[] = [];
  const coloursByPair = new Map<string, Set<Qualification>>();
  for (const q of input.qualifications) {
    if (!trainerIds.has(q.trainerExternalId) || !themaIds.has(q.themaExternalId)) {
      orphanQualRefs.push(`${q.trainerExternalId}::${q.themaExternalId}`);
      continue;
    }
    const key = `${q.trainerExternalId}::${q.themaExternalId}`;
    const set = coloursByPair.get(key) ?? new Set<Qualification>();
    set.add(q.qualification);
    coloursByPair.set(key, set);
  }
  if (orphanQualRefs.length > 0) {
    anomalies.push(
      fatal(
        'unresolved_qual_ref',
        'qualification references an absent trainer/thema',
        orphanQualRefs
      )
    );
  }
  const conflictOverrides: Record<string, 'green' | 'red'> = {};
  const undecidedConflicts: string[] = [];
  for (const [key, colours] of coloursByPair) {
    if (colours.size > 1) {
      const resolved = input.ack.qualConflicts[key];
      // The decision must be bound to the EXACT observed colour set.
      const observed = [...colours].sort().join(',');
      const acknowledged = resolved ? [...new Set(resolved.colours)].sort().join(',') : null;
      if (resolved && acknowledged === observed) {
        conflictOverrides[key] = resolved.effective;
      } else {
        undecidedConflicts.push(key);
      }
    }
  }
  if (undecidedConflicts.length > 0) {
    // Unresolved conflict → effective left NULL (deprecated), like oranje/grijs —
    // we decline to guess whether the trainer gives the theme. Allowed up to a
    // ceiling; a spike (a colour column mass-repointed) re-escalates to fatal. An
    // explicit `qualConflicts` entry still resolves a specific pair to green/red.
    const cap = anomalyCeiling(QUAL_CONFLICT_RATIO, coloursByPair.size);
    const detail = `trainer×theme in multiple colours; effective left unset/deprecated (${undecidedConflicts.length}/${coloursByPair.size}, ceiling ${cap})`;
    anomalies.push(
      undecidedConflicts.length > cap
        ? fatal(
            'qual_conflict_undecided',
            `colour conflicts exceed the ceiling (${undecidedConflicts.length} > ${cap}) — possible colour-column corruption`,
            undecidedConflicts
          )
        : allowed('qual_conflict_undecided', detail, undecidedConflicts)
    );
  }

  // Record every CONSUMED acknowledgement as an allowed anomaly, so sync_runs.anomalies
  // shows exactly which manual corrections shaped the result (audit trail).
  const resolvedConflicts = Object.keys(conflictOverrides);
  if (usedNoBedrijf.length > 0) {
    anomalies.push(
      allowed('applied_no_bedrijf_klant', 'no-Bedrijf klant mappings applied', usedNoBedrijf)
    );
  }
  if (appliedAliases.length > 0) {
    anomalies.push(allowed('applied_klant_alias', 'klant alias decisions applied', appliedAliases));
  }
  if (resolvedConflicts.length > 0) {
    anomalies.push(
      allowed(
        'applied_qual_conflict',
        'qual colour conflicts resolved by allowlist',
        resolvedConflicts
      )
    );
  }

  const fatalCount = anomalies.filter((a) => a.severity === 'fatal').length;
  return { anomalies, fatalCount, klanten, trainingKlant: remappedLinks, conflictOverrides };
}

/** Re-export for callers building the alias worklist. */
export { findAliasCandidates, klantFingerprint, klantIdentityKey };
