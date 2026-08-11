/**
 * The WhatsApp availability message — "Ben jij beschikbaar?" — for one training.
 *
 * A fidelity copy of the n8n node it replaces (`Prepare Training Data`,
 * `flows/flow-6-live-training-sync.md:554-582`), verified against the 455 real messages
 * in `snapshots/airtable/trainingen.json`. The wording is ITG's, not ours: this module
 * exists to reproduce it, not to improve it. The two deliberate departures are marked.
 *
 * Pure — no Monday, no Redis, no clock. Everything it needs arrives in
 * {@link TrainingDetails}.
 */

import type { WhatsappColumn, WhatsappSourceField } from '@lib/monday/board-config';

/** Every line that can appear, in the order it appears. */
export type WhatsappField =
  | 'datum'
  | 'thema'
  | 'tijden'
  | 'taal'
  | 'locatie'
  | 'deelnemers'
  | 'trainers'
  | 'acteurs'
  | 'klant';

export interface TrainingDetails {
  /** ISO `YYYY-MM-DD`, as Monday's date column returns it. */
  datum: string | null;
  /** The free-text Thema, or the theme relation's names as a fallback. */
  thema: string | null;
  tijden: string | null;
  taal: string | null;
  /** The city when we have one, otherwise the raw Locatie text. */
  locatie: string | null;
  /** A TEXT column: "max 15" is a real live value. */
  deelnemers: string | null;
  trainers: number | null;
  acteurs: number | null;
  klant: string | null;
}

export interface GeneratedMessage {
  text: string;
  /**
   * Fields the planner has left blank in Monday, and would probably want to fill in.
   *
   * NOT the complement of {@link GeneratedMessage.rendered}: a single trainer or zero
   * actors produce no line on purpose and belong in neither list. Two questions, two
   * answers — conflating them told every normal training that a populated column was
   * missing, and then told a drifted one that a line existed when it did not.
   */
  omitted: WhatsappField[];
  /** Fields that actually produced a line, whatever source it came from. */
  rendered: WhatsappField[];
  warnings: string[];
}

export const HEADER = 'Ben jij beschikbaar?';

// --- Column drift -----------------------------------------------------------------

/** One board column as Monday reports it. */
export interface ObservedColumn {
  type: string;
  settingsStr: string | null;
}

export interface ColumnDiagnostic {
  field: WhatsappSourceField;
  columnId: string;
  reason: 'missing' | 'type' | 'settings';
}

const stripWs = (value: string): string => value.replace(/\s+/g, '');

/**
 * Compare the configured columns against the board, and return **which field** each
 * problem belongs to.
 *
 * Deliberately not `assertColumns`: that throws and wants a `BoardMeta`, which is right
 * for the engine — drift there corrupts a ranking — and wrong here, where the rest of the
 * message is still correct and editable. And deliberately not `string[]`: the caller has
 * to be able to SUPPRESS the affected value, and a sentence cannot be suppressed.
 */
export function checkWhatsappColumns(
  present: ReadonlySet<string>,
  board: ReadonlyMap<string, ObservedColumn>,
  specs: readonly WhatsappColumn[]
): ColumnDiagnostic[] {
  const diagnostics: ColumnDiagnostic[] = [];

  for (const spec of specs) {
    const { field, id } = spec;
    const column = board.get(id);

    if (column === undefined) {
      // A column the board never had, declared as such, is configuration — not drift.
      if (spec.optional !== true) {
        diagnostics.push({ field, columnId: id, reason: 'missing' });
      }
      continue;
    }
    if (!present.has(id)) {
      diagnostics.push({ field, columnId: id, reason: 'missing' });
      continue;
    }
    if (column.type !== spec.type) {
      diagnostics.push({ field, columnId: id, reason: 'type' });
      continue;
    }
    const needles = spec.settingsIncludes ?? [];
    if (needles.length > 0) {
      const settings = stripWs(column.settingsStr ?? '');
      if (needles.some((needle) => !settings.includes(stripWs(needle)))) {
        diagnostics.push({ field, columnId: id, reason: 'settings' });
      }
    }
  }

  return diagnostics;
}

export interface TrainingDetailsContext {
  /** The Monday item's own name — the klant fallback when the Bedrijf mirror is empty. */
  itemName: string | null;
  /** The resolved city, or null to print the raw Locatie text. */
  city: string | null;
  specs: readonly WhatsappColumn[];
  diagnostics?: readonly ColumnDiagnostic[];
}

/** A whole, clean number, or null. "twee" and "" are absent, never 0. */
function count(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Build the message inputs from the column values.
 *
 * Any field named in `diagnostics` is read as **absent**. That is the whole point of the
 * drift check: a re-sourced Bedrijf mirror still returns a perfectly well-formed company
 * name, just the wrong one, and printing it beside a warning would be a wrong answer
 * dressed as a right one.
 */
export function toTrainingDetails(
  values: ReadonlyMap<string, string>,
  context: TrainingDetailsContext
): TrainingDetails {
  const { itemName, city, specs, diagnostics = [] } = context;
  const drifted = new Set(diagnostics.map((diagnostic) => diagnostic.field));
  const byField = new Map(specs.map((spec) => [spec.field, spec.id]));

  const read = (field: WhatsappSourceField): string | null => {
    if (drifted.has(field)) {
      return null;
    }
    const id = byField.get(field);
    if (id === undefined) {
      return null;
    }
    const value = values.get(id);
    return value === undefined || value.trim() === '' ? null : value;
  };

  return {
    datum: read('datum'),
    thema: read('thema') ?? read('themaRelation'),
    tijden: read('tijden'),
    taal: read('taal'),
    locatie: city ?? read('locatie'),
    deelnemers: read('deelnemers'),
    trainers: count(read('trainers')),
    acteurs: count(read('acteurs')),
    // The item name is dirty on the live board ("KNGF Geleidehonden (copy)"), which is
    // why the mirror is preferred — but a name is better than no klant line at all.
    klant: read('klant') ?? (itemName === null || itemName.trim() === '' ? null : itemName),
  };
}

/**
 * Per-field and whole-message caps.
 *
 * Monday text columns are unbounded and the record that stores an edited message is not,
 * so without a cap a pathological Locatie yields a message that renders perfectly and can
 * never be saved. The message cap is unreachable while the field cap holds (nine fields ×
 * 300 is well under it) and is kept as the invariant the caller can actually rely on.
 */
export const FIELD_MAX_LENGTH = 300;
export const MESSAGE_MAX_LENGTH = 4000;

const LANGUAGES: Record<string, string> = {
  NL: 'Nederlands',
  ENG: 'Engels',
  'NL + ENG': 'Nederlands + Engels',
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** From two. One trainer is the default and saying so would be noise. */
const MIN_TRAINERS_SHOWN = 2;
/** From one. An actor is never the default. */
const MIN_ACTEURS_SHOWN = 1;

interface Line {
  field: WhatsappField;
  text: string;
}

/**
 * Lines that are supposed to be absent most of the time.
 *
 * One trainer and no actors is the ordinary case, and the message deliberately says
 * nothing about either — so their absence is not something the planner forgot to fill
 * in. Counting them as omitted told every normal training that "aantal trainers" was
 * missing from Monday when the column was populated and read correctly.
 */
const CONDITIONAL_FIELDS: ReadonlySet<WhatsappField> = new Set(['trainers', 'acteurs']);

/** A trimmed, non-empty string, or null. Whitespace is absence. */
function clean(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `YYYY-MM-DD` → `DD-MM-JJJJ`, by splitting the string.
 *
 * Deliberately NOT `new Date(iso)`: that reads the value as UTC midnight and
 * `getDate()` then formats it in local time, so every date is a day early anywhere west
 * of UTC. Legacy has that bug; a string split has no timezone to get wrong.
 */
function formatDate(iso: string): string | null {
  const match = ISO_DATE.exec(iso);
  return match === null ? null : `${match[3]}-${match[2]}-${match[1]}`;
}

/** Append `suffix` unless the value already says it. */
function withSuffix(value: string, word: string, suffix: string): string {
  return value.toLowerCase().includes(word) ? value : `${value}${suffix}`;
}

export function formatWhatsappMessage(details: TrainingDetails): GeneratedMessage {
  const warnings: string[] = [];

  /** Trim, cap, and record the cap in the warnings — never silently. */
  const bounded = (field: WhatsappField, value: string | null): string | null => {
    const text = clean(value);
    if (text === null) {
      return null;
    }
    if (text.length <= FIELD_MAX_LENGTH) {
      return text;
    }
    warnings.push(`Het veld "${field}" is ingekort tot ${FIELD_MAX_LENGTH} tekens.`);
    return text.slice(0, FIELD_MAX_LENGTH);
  };

  const candidates: Array<{ field: WhatsappField; text: string | null }> = [];

  const datum = bounded('datum', details.datum);
  candidates.push({ field: 'datum', text: datum === null ? null : formatDate(datum) });

  candidates.push({ field: 'thema', text: bounded('thema', details.thema) });

  const tijden = bounded('tijden', details.tijden);
  candidates.push({ field: 'tijden', text: tijden === null ? null : withSuffix(tijden, 'uur', ' uur') });

  const taal = bounded('taal', details.taal);
  candidates.push({ field: 'taal', text: taal === null ? null : (LANGUAGES[taal] ?? taal) });

  candidates.push({ field: 'locatie', text: bounded('locatie', details.locatie) });

  const deelnemers = bounded('deelnemers', details.deelnemers);
  candidates.push({
    field: 'deelnemers',
    text: deelnemers === null ? null : withSuffix(deelnemers, 'deelnemer', ' deelnemers'),
  });

  const { trainers, acteurs } = details;
  candidates.push({
    field: 'trainers',
    text: trainers !== null && trainers >= MIN_TRAINERS_SHOWN ? `${trainers} trainers` : null,
  });
  candidates.push({
    field: 'acteurs',
    // "+2 acteur", never "acteurs" — legacy's wording, kept on purpose. Changing it is a
    // content decision for ITG, not a typo fix.
    text: acteurs !== null && acteurs >= MIN_ACTEURS_SHOWN ? `+${acteurs} acteur` : null,
  });

  candidates.push({ field: 'klant', text: bounded('klant', details.klant) });

  const lines: Line[] = [];
  const omitted: WhatsappField[] = [];
  for (const candidate of candidates) {
    if (candidate.text === null) {
      // Absent-by-design is not absent-by-omission — see CONDITIONAL_FIELDS.
      if (!CONDITIONAL_FIELDS.has(candidate.field)) {
        omitted.push(candidate.field);
      }
      continue;
    }
    lines.push({ field: candidate.field, text: candidate.text });
  }

  // An empty field DROPS its line. Legacy emits the newline regardless, so a training
  // without Tijden gets a blank line mid-message — a defect, not a format.
  const body = lines.map((line) => line.text).join('\n');
  const full = body === '' ? HEADER : `${HEADER}\n\n${body}`;

  const rendered = lines.map((line) => line.field);
  const text = full.length <= MESSAGE_MAX_LENGTH ? full : full.slice(0, MESSAGE_MAX_LENGTH);
  if (text !== full) {
    warnings.push(`Het bericht is ingekort tot ${MESSAGE_MAX_LENGTH} tekens.`);
  }

  return { text, omitted, rendered, warnings };
}
