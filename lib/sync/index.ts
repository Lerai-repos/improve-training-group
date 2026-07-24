/**
 * Sync/ingest layer: maps Monday-domain objects into the DB, split by ownership.
 * `syncPlanningFromMonday` writes only planning columns; `updateEvaluationSnapshot`
 * writes only evaluation snapshots. Neither touches the other's columns, so a
 * planning sync can never clobber imported evaluation data (and vice versa).
 */
export { syncPlanningFromMonday, type PlanningSyncResult } from './planning';
export { updateEvaluationSnapshot, type EvaluationSnapshotInput } from './evaluation';
export {
  buildArtifact,
  deriveEffective,
  type MondaySnapshotArtifact,
  type BuildArtifactInput,
} from './artifact';
