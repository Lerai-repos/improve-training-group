/**
 * Monday integration boundary.
 *
 * `MondayPort` is the single interface the system depends on. M1 ships only the
 * mock; connecting later means implementing this one interface with GraphQL
 * (inline board_relation/mirror fragments + pinned API version). The decoder
 * (transport→domain) is built and tested now so that implementation is a small,
 * well-understood step.
 */
export type { MondayPort } from './port';
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
  linkedItemIds,
  mirrorValue,
  type RawMondayItem,
  type RawColumnValue,
  type TrainingColumnMap,
} from './decode';
