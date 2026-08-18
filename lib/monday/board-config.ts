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

/** ITG's real planning board. Never change this — override per environment instead. */
export const AGENDA_2026_PRODUCTION_BOARD = '5087396949';

/**
 * The Agenda board trainings are read from and our status column is written to.
 *
 * Overridable via `MONDAY_AGENDA_BOARD_ID` so the whole pipeline can be aimed at a
 * DUPLICATE of Agenda 2026 — a board copy keeps every column id and group id, so
 * only this one value changes. That is what makes an end-to-end test possible
 * without writing to ITG's live planning board.
 *
 * `||`, not `??`: a blank override must fall back to production rather than produce
 * an empty board id, which Monday answers with an empty board — i.e. "no trainings"
 * rather than an error.
 *
 * ⚠️ Going live means UNSETTING `MONDAY_AGENDA_BOARD_ID` everywhere (local, Doppler,
 * Vercel) — there is nothing to revert in code. While it is set, the engine does not
 * touch ITG's real board at all, so a forgotten override is a silent no-op on
 * production, not a visible failure. Check it before declaring the engine live.
 */
export function agendaBoardId(): string {
  return process.env.MONDAY_AGENDA_BOARD_ID || AGENDA_2026_PRODUCTION_BOARD;
}

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
  uurtarief: 'itg_uurtarief',
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

/**
 * The columns the WhatsApp availability message is built from.
 *
 * A SEPARATE set from `AGENDA_EXPECTED_COLUMNS` because the consequence of drift is
 * different: there, a retyped relation silently corrupts a ranking and the run must die;
 * here, one line of a message the planner is about to edit anyway goes missing. So these
 * are checked with the same rigour and handled by degrading — see `checkWhatsappColumns`.
 *
 * `settingsIncludes` is what catches SAME-TYPE drift. A Bedrijf mirror re-sourced to
 * another board, or the Thema relation repointed, keeps its type and quietly yields the
 * wrong klant or the wrong theme — a wrong answer, which is worse than a missing one.
 */
export interface WhatsappColumn extends ExpectedColumn {
  field: WhatsappSourceField;
  /** Declared absent on this board (not drift) — e.g. Acteuraantal on Agenda 2024. */
  optional?: boolean;
}

export type WhatsappSourceField =
  | 'datum'
  | 'thema'
  | 'themaRelation'
  | 'tijden'
  | 'taal'
  | 'locatie'
  | 'deelnemers'
  | 'trainers'
  | 'acteurs'
  | 'klant';

const AGENDA_2026_WHATSAPP_COLUMNS: readonly WhatsappColumn[] = [
  { field: 'datum', id: 'datum_1', type: 'date' },
  // Monday's free-text "Thema", NOT the board relation: the corpus shows the message
  // carries "Boksen voor teams + co trainer" where the linked theme is merely "Boksen".
  { field: 'thema', id: 'tekst', type: 'text' },
  {
    field: 'themaRelation',
    id: 'board_relation_mkz4920y',
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[5067928440]'],
  },
  { field: 'tijden', id: 'dup__of_workshop', type: 'text' },
  { field: 'taal', id: 'dup__of_trainers', type: 'dropdown' },
  { field: 'locatie', id: 'tekst7', type: 'text' },
  { field: 'deelnemers', id: 'deelnemersaantal__1', type: 'text' },
  { field: 'trainers', id: 'nummers5', type: 'numbers' },
  { field: 'acteurs', id: 'numeric_mm0nhbn7', type: 'numbers' },
  {
    field: 'klant',
    id: 'lookup_mkszzfvr',
    type: 'mirror',
    settingsIncludes: ['1279052045', 'connect_boards31'],
  },
];

/**
 * Per jaargang. Only 2026 is wired — the engine reads no other Agenda board — but the
 * differences are recorded here because they are exactly what the Instellingen board has
 * to carry, and because the 2025 relation ids have already caused one wrong-column bug.
 *
 * ⚠️ The 2024 and 2025 entries are derived from the cross-board difference table in
 * `platform-structures/monday.md` and are NOT verified against those boards live.
 */
const AGENDA_2025_WHATSAPP_COLUMNS: readonly WhatsappColumn[] = AGENDA_2026_WHATSAPP_COLUMNS.map(
  (column) =>
    column.field === 'themaRelation' ? { ...column, id: 'board_relation_mkz4hjnt' } : column
);

const AGENDA_2024_WHATSAPP_COLUMNS: readonly WhatsappColumn[] = AGENDA_2026_WHATSAPP_COLUMNS.flatMap(
  (column) => {
    switch (column.field) {
      // Acteuraantal does not exist on Agenda 2024 — a property of that board, not drift.
      case 'acteurs':
        return [];
      case 'themaRelation':
        return [{ ...column, id: 'board_relation_mkz45ap0' }];
      case 'klant':
        return [{ ...column, id: 'lookup_mkwyaxh1' }];
      default:
        return [column];
    }
  }
);

const WHATSAPP_COLUMNS_BY_BOARD: Record<string, readonly WhatsappColumn[]> = {
  [AGENDA_2026_PRODUCTION_BOARD]: AGENDA_2026_WHATSAPP_COLUMNS,
  '1703587792': AGENDA_2025_WHATSAPP_COLUMNS,
  '1311331281': AGENDA_2024_WHATSAPP_COLUMNS,
};

/**
 * Falls back to the 2026 set for an unknown board id — which is the right answer for the
 * one that matters: `MONDAY_AGENDA_BOARD_ID` points at a DUPLICATE of Agenda 2026, and a
 * board copy keeps every column id.
 */
export function whatsappColumnsFor(boardId: string): readonly WhatsappColumn[] {
  return WHATSAPP_COLUMNS_BY_BOARD[boardId] ?? AGENDA_2026_WHATSAPP_COLUMNS;
}

/**
 * The columns that make a board recognisably the Trainers board.
 *
 * Deliberately WITHOUT the rate columns below: `trainers:tarief` asserts this list to
 * prove it is pointed at the right board *before* creating those columns, so including
 * them would make the provisioning command require what it exists to add.
 */
export const TRAINER_EXPECTED_COLUMNS: ExpectedColumn[] = [
  { id: 'adres__1', type: 'text' },
  { id: 'e_mail__1', type: 'email' },
  { id: 'itg_mail__1', type: 'email' }, // email fallback
  { id: 'telefoon_mkn1hbyh', type: 'text' },
];

/**
 * The per-trainer rate override, created by `pnpm trainers:tarief` (18-Aug-2026).
 *
 * Asserted STRICTLY on the engine path, which is the point of it. Monday omits a column
 * id it does not recognise rather than erroring, so a deleted `Uurtarief` would read as
 * "nobody has an override" — every trainer silently falling back to their cohort rate,
 * which is a perfectly plausible set of numbers and wrong for anyone who had one set.
 *
 * `Datum instroom` is NOT here on purpose: nothing reads it, so its absence cannot make
 * us wrong, and requiring a column ITG owns purely for their own administration would
 * turn their housekeeping into an outage.
 */
export const TRAINER_RATE_COLUMNS: ExpectedColumn[] = [{ id: 'itg_uurtarief', type: 'numbers' }];

/** What the engine insists on: the board's identity plus the rate override. */
export const TRAINER_ENGINE_COLUMNS: ExpectedColumn[] = [
  ...TRAINER_EXPECTED_COLUMNS,
  ...TRAINER_RATE_COLUMNS,
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
  /**
   * Seeds the DEFAULT recommendable selection only. The live selection is config
   * (`RECOMMENDABLE_TRAINER_GROUPS`); nothing reads this flag at runtime.
   */
  recommendable: boolean;
}

/**
 * Group → RATE policy. INGESTION IS NEVER FILTERED BY THIS — every trainer is
 * imported with its raw group; this drives downstream rate resolution only. Which
 * groups M2b may recommend from is NO LONGER decided here: it is configurable via
 * the `RECOMMENDABLE_TRAINER_GROUPS` config key (fase-2a "selecteerbare
 * trainergroepen"), and this table merely seeds that config's default.
 * Only the two rate cohorts are mapped; the other live groups (Acteurs,
 * Schaduwpool, Inactief, …) are CLIENT decisions — an unmapped group is flagged as
 * an anomaly but the trainer is still imported.
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

/**
 * The DEFAULT recommendable group ids, used only to seed `CONFIG_DEFAULTS`. The
 * effective selection is the `RECOMMENDABLE_TRAINER_GROUPS` config row.
 */
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
/**
 * "Herplannen / Inplannen" — the group a training goes to when it is being REplanned,
 * which is exactly when its recommendations should be recomputed.
 *
 * The id is a Monday default (`nieuwe_groep`) and the title is confusingly close to
 * the group above, which is how a test drag once landed here and looked like a dead
 * webhook: the move happened, just not into the group we subscribed to.
 *
 * n8n listens only to `INPLANNEN_GROUP_ID`, so trainings moved here are handled by us
 * alone — there is no legacy result to compare against for this group.
 */
export const HERPLANNEN_GROUP_ID = 'nieuwe_groep';

/** Every group whose arrival triggers a run. Order is irrelevant; membership is. */
export const TRIGGER_GROUP_IDS: readonly string[] = [INPLANNEN_GROUP_ID, HERPLANNEN_GROUP_ID];

/**
 * The trigger groups, with `MONDAY_TRIGGER_GROUP_IDS` (comma-separated) able to
 * override them. Setting it REPLACES the defaults rather than adding to them.
 *
 * Named for the list it is, not for one of the groups in it: the previous
 * `MONDAY_INPLANNEN_GROUP_ID` was singular AND named one of the two groups it
 * controlled, so setting it to "the Inplannen group id" silently unsubscribed
 * Herplannen. No amount of comment could out-argue a name that says the wrong thing.
 *
 * Blank entries are dropped and an all-blank value falls back to the defaults. That
 * is the same fail-closed rule the single-id version had, for the same reason: a
 * trailing comma or `MONDAY_TRIGGER_GROUP_IDS=` would otherwise produce an empty id
 * that matches no group, so every group-move trigger would be ignored behind a
 * perfectly healthy 200 — nothing logged above debug, nothing on the board, nothing
 * that looks broken.
 *
 * ⚠️ Configuration alone does NOT subscribe. Monday delivers
 * `item_moved_to_specific_group` only for groups a webhook was registered for, so
 * adding an id here without running `pnpm webhook:register` changes nothing. See
 * §10 of `docs/m2b/README.md` before moving this to the Instellingen board.
 *
 * Lives here rather than in `deps.ts` so `webhook:register` can read it without
 * pulling in the Redis/QStash dependency graph.
 */
export function triggerGroupIds(): readonly string[] {
  const configured = (process.env.MONDAY_TRIGGER_GROUP_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return configured.length > 0 ? configured : TRIGGER_GROUP_IDS;
}

/**
 * OUR status column — a SECOND status column on Agenda 2026, created by ITG, that
 * this engine writes while n8n keeps `RECOMMENDATION_STATUS_COLUMN`. The two run
 * side by side until ours is provably clean; only then is the legacy one retired.
 *
 * The id lives in env because the column is created by hand on the live board. The
 * equality guard is the point: a typo or a copied value that aimed our writer at
 * n8n's column would silently take over the legacy flow, which is exactly the
 * outcome the side-by-side rollout exists to avoid.
 */
export function ourStatusColumnId(): string {
  const id = process.env.MONDAY_RECOMMENDATION_STATUS_COLUMN;
  if (!id) {
    throw new Error(
      'Missing MONDAY_RECOMMENDATION_STATUS_COLUMN — the status column this engine writes'
    );
  }
  if (id === RECOMMENDATION_STATUS_COLUMN) {
    throw new Error(
      `MONDAY_RECOMMENDATION_STATUS_COLUMN must not be ${RECOMMENDATION_STATUS_COLUMN} — that column belongs to n8n`
    );
  }
  return id;
}

/**
 * NOTE: our status column deliberately has NO schema preflight.
 *
 * It is a WRITE target, never read, so the fail-open decoding that makes drift
 * dangerous on the trainers and Thema's boards does not apply: if the column were
 * retyped or deleted, `change_column_value` errors, the job retries, and it reaches
 * the DLQ with an alert. That is already loud. Preflighting it would mean an extra
 * `boards { columns }` query on every job — no route otherwise fetches Agenda board
 * metadata — for a failure mode that cannot pass silently.
 *
 * The reads that DO fail open (`roster.ts`, `qualifications.ts`) are gated by
 * `assertColumns`, and that is where drift genuinely has to be caught.
 */

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
