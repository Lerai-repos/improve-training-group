/**
 * Monday integration boundary.
 *
 * `MondayPort` is the single interface the system depends on. M1 ships only the
 * mock; connecting later means implementing this one interface with GraphQL
 * (inline board_relation/mirror fragments + pinned API version). The decoder
 * (transport→domain) is built and tested now so that implementation is a small,
 * well-understood step.
 */
export type { MondayPort, MondayReadPort, MondayWritePort } from './port';
export {
  validateSnapshot,
  parseAcknowledgements,
  acknowledgementsSchema,
  EMPTY_ACK,
  type Acknowledgements,
  type Anomaly,
  type Severity,
  type ValidationInput,
  type ValidationResult,
} from './validate';
export type {
  MondayBoardScope,
  Page,
  MondayTrainer,
  MondayThema,
  MondayKlant,
  MondayTraining,
  MondayQualification,
  TrainingSyncWrite,
} from './types';
export {
  createMockMondayPort,
  type MockMondayPort,
  type MockMondayData,
  type RecordedWrite,
} from './mock';
export {
  decodeTraining,
  decodeTrainer,
  decodeThema,
  decodeQualificationsFromThema,
  linkedItemIds,
  mirrorValue,
  type RawMondayItem,
  type RawColumnValue,
  type TrainingColumnMap,
  type TrainerColumnMap,
  type QualificationColourMap,
  type Diagnostic,
  type DiagnosticKind,
  type Decoded,
} from './decode';
