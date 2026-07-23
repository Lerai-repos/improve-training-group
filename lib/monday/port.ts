import type {
  MondayBoardScope,
  MondayKlant,
  MondayQualification,
  MondayThema,
  MondayTrainer,
  MondayTraining,
  Page,
  TrainingSyncWrite,
} from './types';

/**
 * The Monday domain port — the single interface the rest of the system depends
 * on. M1 ships a mock implementation; "connecting" later means implementing this
 * same interface once, with GraphQL (inline `board_relation`/`mirror` fragments,
 * pinned API version). Nothing downstream changes.
 *
 * Reads are board/year-scoped and paginated so a full sync can pull incrementally.
 */
export interface MondayPort {
  getTrainings(scope: MondayBoardScope): Promise<Page<MondayTraining>>;
  getTrainers(scope: MondayBoardScope): Promise<Page<MondayTrainer>>;
  getThemas(scope: MondayBoardScope): Promise<Page<MondayThema>>;
  getKlanten(scope: MondayBoardScope): Promise<Page<MondayKlant>>;

  /** Trainer×theme qualifications (from the color-coded board_relation columns). */
  getQualifications(scope: MondayBoardScope): Promise<MondayQualification[]>;

  /** Write the backend record id, app URL, and both status columns for one item. */
  writeTrainingSync(itemId: string, write: TrainingSyncWrite): Promise<void>;

  /** Generic column write — escape hatch for one-off updates. */
  updateColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}
