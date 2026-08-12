/**
 * Evaluation statistics: raw Google Sheets responses → one (trainer × thema) row.
 *
 * Layering: this module may import `@lib/calc` and `@lib/monday`, never
 * `@lib/recommend` — the engine adapter imports this, so the reverse edge would close a
 * cycle. Qualifications therefore arrive as plain `QualificationObservation` data,
 * assembled by whoever composes the run (the cron and the seed script, which may import
 * both sides).
 */

export type {
  BoardQualification,
  EvaluationResponse,
  QualificationColour,
  QualificationObservation,
  SheetRef,
  TrainerThemaStatRow,
  TrainingAggregate,
  TrainingHistoryEntry,
  TrainingRef,
} from './types';

export { normalizeHeader, resolveColumns, type ResolvedColumns } from './header-map';

export {
  decodeGrid,
  sheetValuesSchema,
  sourceConfigSchema,
  type CellAnomaly,
  type EvaluationSource,
  type ReadResult,
  type SheetDecode,
  type SheetReadSummary,
  type SourceConfig,
} from './sheets-reader';

export { csvEvaluationSource, parseCsv, type CsvInput } from './csv-source';

export {
  attributeResponses,
  normalizeCode,
  splitIeCodes,
  MAX_LOSS_SAMPLES,
  type AttributionReport,
  type AttributionResult,
  type LossKind,
  type ResponseLoss,
  type ResponseRef,
} from './attribute';

export {
  amsterdamToday,
  boardQualification,
  computeTrainerThemaStats,
  isCompleted,
  toTrainerThemeEvals,
  type StatsInput,
  type StatsReport,
  type StatsResult,
} from './stats';

export {
  AGENDA_2025_HISTORY,
  AGENDA_2026_HISTORY,
  AGENDA_HISTORY_BOARDS,
  agendaHistoryExpectedColumns,
  type AgendaHistoryColumns,
} from './agenda-columns';

export {
  readAgendaHistory,
  type AgendaHistory,
  type AgendaHistoryClient,
  type AgendaTraining,
} from './agenda-history';




export {
  EVALUATION_DOCUMENTS,
  SHEETS_READONLY_SCOPE,
  evaluationDocuments,
  oauthCredentialsFromEnv,
  oauthCredentialsSchema,
  type OAuthCredentials,
} from './sheet-documents';

export {
  consentUrl,
  createOAuthGoogleAuth,
  exchangeCode,
  googleSheetsSource,
  type GoogleAuth,
} from './google-sheets-source';

export {
  STATS_TTL_MS,
  createStatsStore,
  type StatsSnapshot,
  type StatsStore,
} from './stats-store';

export {
  DROP_FACTOR,
  MIN_RESPONSES,
  MIN_ROWS,
  commitNightly,
  prepareNightly,
  runNightly,
  type NightlyDeps,
  type NightlyOptions,
  type NightlyReport,
  type PreparedNightly,
  type RefusalReason,
} from './nightly';

export {
  KNOWN_TIMES_GIVEN_DIFFS,
  KNOWN_EXTRA_PAIRS,
  MIN_COMPARED_ROWS,
  MIN_COMPARED_TRAINERS,
  runTierA,
  type AirtableRecord,
  type TierAMismatch,
  type TierAResult,
} from './tier-a';
