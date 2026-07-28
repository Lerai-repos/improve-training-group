import type { QualificationColourMap, TrainerColumnMap, TrainingColumnMap } from './decode';

/**
 * Live Monday board + column configuration for M2a (Agenda 2026 only). Ids are
 * from the locked Slice-A schema inventory (`docs/m2a/audit-report.md` /
 * platform-structures/monday.md). This is plumbing config — a candidate to move
 * into the DB `config` table later; for now it is a typed, reviewed constant.
 */

/**
 * The pinned Monday API version — the SOLE source of truth for the live clients
 * (there is deliberately NO DB/config mirror: dry-run is DB-free, so the version
 * can't come from the DB). `2026-07` is the current version and the one the decoder
 * was validated against end-to-end (a real 754-row `--apply` decoded board_relation/
 * mirror fragments correctly). The board_relation `value:null` / mirror-null "gotcha"
 * persists in 2026-07, so the fragment-based decoder still applies.
 */
export const MONDAY_API_VERSION = '2026-07';

export const AGENDA_2026_BOARD = '5087396949';
export const TRAINERS_BOARD = '1661151090';
export const THEMAS_BOARD = '5067928440';

export const AGENDA_2026_COLUMNS: TrainingColumnMap = {
  trainerRelation: 'board_relation_mkz4y7tb',
  themaRelation: 'board_relation_mkz4920y',
  companyMirror: 'lookup_mkszzfvr',
  datum: 'datum_1',
  duur: 'nummers_mkmvc0rk',
  ieCode: 'tekst_mkn58pt6',
  locatie: 'tekst7',
  label: 'status23',
  omzet: 'nummers',
  tijd: 'dup__of_workshop',
  taal: 'dup__of_trainers',
};

export const TRAINER_COLUMNS: TrainerColumnMap = {
  adres: 'adres__1',
  email: 'e_mail__1',
  itgEmail: 'itg_mail__1',
  telefoon: 'telefoon_mkn1hbyh',
};

export const THEMA_QUAL_COLOURS: QualificationColourMap = {
  groen: 'board_relation_mky0qxcw',
  oranje: 'board_relation_mky0ftmb',
  rood: 'board_relation_mky02vvy',
  grijs: 'board_relation_mky0vkax',
};

/** Item fields for a full board pull (matches the decoders' expectations). */
export const ITEM_FIELDS = `
  id
  name
  updated_at
  board { id }
  group { id title }
  column_values {
    id
    type
    text
    value
    __typename
    ... on BoardRelationValue { linked_item_ids display_value }
    ... on MirrorValue { display_value }
  }
`;

/**
 * Configured column id + expected Monday type + optional `settings_str` signature
 * substrings (whitespace-insensitive). The signature catches a SAME-TYPE change —
 * a relation repointed to a different board, or the Bedrijf mirror re-sourced —
 * which would silently corrupt links/klant derivation. Covers EVERY consumed
 * column (a retyped tijd/taal/email would be overwritten with null otherwise).
 */
export interface ExpectedColumn {
  id: string;
  type: string;
  settingsIncludes?: string[];
}

export const AGENDA_EXPECTED_COLUMNS: ExpectedColumn[] = [
  {
    id: 'board_relation_mkz4y7tb',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1661151090]'],
  },
  {
    id: 'board_relation_mkz4920y',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[5067928440]'],
  },
  { id: 'lookup_mkszzfvr', type: 'mirror', settingsIncludes: ['1279052045', 'connect_boards31'] },
  { id: 'datum_1', type: 'date' },
  { id: 'nummers_mkmvc0rk', type: 'numbers' },
  { id: 'nummers', type: 'numbers' },
  { id: 'tekst7', type: 'text' },
  { id: 'status23', type: 'status' },
  { id: 'tekst_mkn58pt6', type: 'text' },
  { id: 'dup__of_workshop', type: 'text' }, // tijd
  { id: 'dup__of_trainers', type: 'dropdown' }, // taal
];

export const TRAINER_EXPECTED_COLUMNS: ExpectedColumn[] = [
  { id: 'adres__1', type: 'text' },
  { id: 'e_mail__1', type: 'email' },
  { id: 'itg_mail__1', type: 'email' }, // email fallback
  { id: 'telefoon_mkn1hbyh', type: 'text' },
];

export const THEMA_EXPECTED_COLUMNS: ExpectedColumn[] = [
  {
    id: 'board_relation_mky0qxcw',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1661151090]'],
  },
  {
    id: 'board_relation_mky0ftmb',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1661151090]'],
  },
  {
    id: 'board_relation_mky02vvy',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1661151090]'],
  },
  {
    id: 'board_relation_mky0vkax',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1661151090]'],
  },
];

export interface GroupPolicy {
  /** rate_cards key, or null for no cohort (variabel/unset). */
  rateKey: string | null;
  /** Whether M2b may recommend trainers from this group. */
  recommendable: boolean;
}

/**
 * Group → rate/eligibility policy. INGESTION IS NEVER FILTERED BY THIS — every
 * trainer is imported with its raw group; this only drives downstream rate
 * resolution + M2b recommendation. Only the two rate cohorts are seeded; the
 * other live groups (Acteurs, Schaduwpool, Inactief, …) are CLIENT decisions —
 * an unmapped group is flagged as an anomaly but the trainer is still imported.
 */
export const GROUP_POLICY: Record<string, GroupPolicy> = {
  topics: { rateKey: '2020-2024', recommendable: true },
  nieuwe_groep__1: { rateKey: '2024-heden', recommendable: true },
};

export function resolveGroupPolicy(groupId: string | null): GroupPolicy | null {
  if (!groupId) {
    return null;
  }
  return GROUP_POLICY[groupId] ?? null;
}

/** The recommendable-cohort group ids (from GROUP_POLICY) — the eligibility prefilter. */
export function recommendableGroups(): string[] {
  return Object.keys(GROUP_POLICY).filter((g) => GROUP_POLICY[g].recommendable);
}

// --- M2b recommendation-engine columns on Agenda 2026 (from the live board dump) ---
/** Status column written by the engine: RUN (button) → GEREED | GEEN MATCH | FOUT. */
export const RECOMMENDATION_STATUS_COLUMN = 'color_mkzwfy42';
/** The "Aanbevelingen" button that triggers a manual run (sets the status to RUN). */
export const RECOMMENDATION_BUTTON_COLUMN = 'button_mkzw7xx2';
/** "Trainers contactgegevens" board_relation (the confirmed-trainer link, flow-7). */
export const TRAINER_LINK_COLUMN = 'board_relation_mkz4y7tb';
/** The "Inplannen" group (verified live) — moving a training here triggers a run. */
export const INPLANNEN_GROUP_ID = 'group_mkwtj07a';

export interface RecommendationStatusLabels {
  run: string;
  done: string;
  noMatch: string;
  error: string;
}
export const RECOMMENDATION_STATUS_LABELS: RecommendationStatusLabels = {
  run: 'RUN',
  done: 'GEREED',
  noMatch: 'GEEN MATCH',
  error: 'FOUT',
};
