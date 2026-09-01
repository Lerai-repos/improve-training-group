/**
 * Which column holds the IE-code, and which holds the eindcijfer.
 *
 * Three header shapes exist for the same tab: `Code` on the live sheet (what every n8n
 * node matches on), `IE-code` on the older documents, and the full question text in a
 * CSV export. So the column cannot be hardcoded — but nor can it be guessed.
 *
 * The resolution is a ladder with an ambiguity guard and **no positional fallback**.
 * That last part is the load-bearing decision: ITG edits these sheets, the NL export
 * already carries six operator-added `Kolom N` columns, and a column inserted before
 * the code column would make every response carry a grade as its code, match nothing,
 * and produce a perfectly green run that has silently lost every response. Failing
 * loudly is the only safe answer, so an unresolved required column is an error rather
 * than a default.
 */

export interface ResolvedColumns {
  readonly code: number;
  readonly grade: number;
  /** Carried for the report; nothing parses it. Absent is fine. */
  readonly timestamp: number | null;

  /**
   * The eight columns only the evaluation REPORT reads: five more 1-5 questions, the
   * follow-up question, and the two free-text fields the quote lists come from.
   *
   * All nullable, and that is deliberate. This resolver is shared with the nightly
   * statistics job, which opens only `code` and `grade`. A required question column
   * would mean that ITG renaming a question — which has happened once already — takes
   * the trainer statistics down over a column that job never reads. A gap here is a
   * gap in one report section; a refusal here would be a blank corpus.
   */
  readonly program: number | null;
  readonly practical: number | null;
  readonly tools: number | null;
  readonly trainerExpertise: number | null;
  readonly trainerCommunication: number | null;
  readonly followUp: number | null;
  readonly positive: number | null;
  readonly improvement: number | null;
}

/** The report-only fields, in the order the report presents them. */
export const REPORT_COLUMN_FIELDS = [
  'program',
  'practical',
  'tools',
  'trainerExpertise',
  'trainerCommunication',
  'followUp',
  'positive',
  'improvement',
] as const;

export type ReportColumnField = (typeof REPORT_COLUMN_FIELDS)[number];

/**
 * The report half of a resolution for a sheet that has none of those columns — the live
 * tab and the 2024/2025 archives. Written out rather than derived, because deriving it
 * from `REPORT_COLUMN_FIELDS` needs a cast to satisfy the record type, and this repo
 * does not cast.
 */
export const NO_REPORT_COLUMNS: Readonly<Record<ReportColumnField, null>> = {
  program: null,
  practical: null,
  tools: null,
  trainerExpertise: null,
  trainerCommunication: null,
  followUp: null,
  positive: null,
  improvement: null,
};

export type HeaderResolution =
  | { readonly ok: true; readonly columns: ResolvedColumns }
  | { readonly ok: false; readonly reason: string; readonly headers: readonly string[] };

/**
 * NFKD → drop combining marks → lowercase → every non-alphanumeric run becomes one
 * space → trim.
 *
 * This is what makes a two-word marker like `final grade` safe: it collapses the EN
 * code header's embedded newline and the EN program question's accidental double
 * space, both of which are really in the live data.
 */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface ColumnSpec {
  readonly field: 'code' | 'grade' | 'timestamp' | ReportColumnField;
  /** Exact normalized names, tried first, in order. */
  readonly aliases: readonly string[];
  /** Substrings, tried only when no alias hit. Each must match EXACTLY one header. */
  readonly markers: readonly string[];
  readonly required: boolean;
}

const COLUMN_SPECS: readonly ColumnSpec[] = [
  {
    field: 'code',
    aliases: ['code', 'ie code', 'iecode'],
    markers: ['ie code', 'code'],
    required: true,
  },
  {
    field: 'grade',
    aliases: ['eindcijfer', 'final grade'],
    markers: ['eindcijfer', 'final grade', 'cijfer', 'grade'],
    required: true,
  },
  {
    field: 'timestamp',
    aliases: ['tijdstempel', 'timestamp'],
    markers: ['tijdstempel', 'timestamp'],
    required: false,
  },

  /**
   * The report questions. Every one needs a Dutch AND an English marker: the two live
   * forms ask the same nine questions in different words, and the EN sheet is a real
   * source (235 responses) that legacy never read.
   *
   * The markers below were each checked against the full NL and EN exports — all
   * eleven columns resolve to exactly one header in both, with no collisions. No
   * aliases: nobody types these questions as a short column name.
   */
  {
    field: 'program',
    aliases: [],
    markers: ['programma inhoudelijk', 'in terms of content'],
    required: false,
  },
  {
    field: 'practical',
    aliases: [],
    markers: ['praktijkgericht', 'practical hands on'],
    required: false,
  },
  {
    field: 'tools',
    aliases: [],
    markers: ['concrete handvatten', 'concrete tools'],
    required: false,
  },
  {
    field: 'trainerExpertise',
    aliases: [],
    markers: ['vakkundig', 'knowledgeable'],
    required: false,
  },
  {
    field: 'trainerCommunication',
    aliases: [],
    markers: ['communicatie en omgang', 'communication and interaction'],
    required: false,
  },
  {
    field: 'followUp',
    aliases: [],
    markers: ['opvolgsessie', 'follow up session'],
    required: false,
  },
  {
    field: 'positive',
    aliases: [],
    markers: ['positief terug', 'back on positively'],
    required: false,
  },
  {
    field: 'improvement',
    aliases: [],
    markers: ['ruimte voor verbetering', 'room for improvement'],
    required: false,
  },
];

/** Indexes whose normalized header equals `needle`. */
function exactHits(headers: readonly string[], needle: string): number[] {
  return headers.flatMap((header, index) => (header === needle ? [index] : []));
}

/** Indexes whose normalized header contains `needle`. */
function substringHits(headers: readonly string[], needle: string): number[] {
  return headers.flatMap((header, index) => (header.includes(needle) ? [index] : []));
}

type FieldResolution =
  | { readonly kind: 'found'; readonly index: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous'; readonly needle: string; readonly indexes: readonly number[] };

/**
 * Resolve one field.
 *
 * An alias matching two columns is fatal immediately — two columns literally named
 * `Code` is drift, and picking one attributes every response through a coin flip. A
 * *marker* matching two is not fatal on its own: the next, more specific marker gets a
 * turn. Only when every marker is exhausted does ambiguity surface.
 */
function resolveField(headers: readonly string[], spec: ColumnSpec): FieldResolution {
  for (const alias of spec.aliases) {
    const hits = exactHits(headers, alias);
    if (hits.length === 1) {
      return { kind: 'found', index: hits[0] };
    }
    if (hits.length > 1) {
      return { kind: 'ambiguous', needle: alias, indexes: hits };
    }
  }

  let ambiguous: FieldResolution | null = null;
  for (const marker of spec.markers) {
    const hits = substringHits(headers, marker);
    if (hits.length === 1) {
      return { kind: 'found', index: hits[0] };
    }
    if (hits.length > 1 && ambiguous === null) {
      ambiguous = { kind: 'ambiguous', needle: marker, indexes: hits };
    }
  }

  return ambiguous ?? { kind: 'absent' };
}

export function resolveColumns(header: readonly string[]): HeaderResolution {
  const headers = header.map(normalizeHeader);
  const found = new Map<ColumnSpec['field'], number>();

  for (const spec of COLUMN_SPECS) {
    const resolution = resolveField(headers, spec);

    if (resolution.kind === 'ambiguous') {
      if (!spec.required) {
        // Still refusing to guess — just at the granularity of the one column nobody's
        // statistics depend on, rather than failing the read and blanking the corpus.
        continue;
      }
      return {
        ok: false,
        reason:
          `column "${spec.field}": "${resolution.needle}" matches ` +
          `${resolution.indexes.length} columns (${resolution.indexes.join(', ')}) — refusing to guess`,
        headers,
      };
    }
    if (resolution.kind === 'absent') {
      if (spec.required) {
        return {
          ok: false,
          reason: `column "${spec.field}": no header matched — refusing to fall back to a position`,
          headers,
        };
      }
      continue;
    }
    found.set(spec.field, resolution.index);
  }

  const code = found.get('code');
  const grade = found.get('grade');
  if (code === undefined || grade === undefined) {
    // Unreachable: both are required and a missing required field returned above.
    return { ok: false, reason: 'required columns unresolved', headers };
  }

  const optional = (field: ColumnSpec['field']): number | null => found.get(field) ?? null;

  return {
    ok: true,
    columns: {
      code,
      grade,
      timestamp: optional('timestamp'),
      program: optional('program'),
      practical: optional('practical'),
      tools: optional('tools'),
      trainerExpertise: optional('trainerExpertise'),
      trainerCommunication: optional('trainerCommunication'),
      followUp: optional('followUp'),
      positive: optional('positive'),
      improvement: optional('improvement'),
    },
  };
}
