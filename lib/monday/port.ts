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
 * The Monday domain port, split so read-only consumers CAN'T write.
 *
 * A Monday PAT inherits the user's permissions, so read-only must be structural,
 * not a promise. M2a depends only on {@link MondayReadPort}; its GraphQL adapter
 * implements only the reads (no dormant write methods). Writes ({@link
 * MondayWritePort}) land in M2c.
 *
 * Reads are board/year-scoped and paginated so a full sync can pull incrementally.
 */
export interface MondayReadPort {
  getTrainings(scope: MondayBoardScope): Promise<Page<MondayTraining>>;
  getTrainers(scope: MondayBoardScope): Promise<Page<MondayTrainer>>;
  getThemas(scope: MondayBoardScope): Promise<Page<MondayThema>>;
  getKlanten(scope: MondayBoardScope): Promise<Page<MondayKlant>>;

  /** Trainer×theme qualifications (from the colour-coded board_relation columns). */
  getQualifications(scope: MondayBoardScope): Promise<MondayQualification[]>;
}

export interface MondayWritePort {
  /** Write the backend record id, app URL, and both status columns for one item. */
  writeTrainingSync(itemId: string, write: TrainingSyncWrite): Promise<void>;

  /** Generic column write — escape hatch for one-off updates. */
  updateColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

/** The full port (reads + writes). The mock implements this; M2a uses only the read half. */
export interface MondayPort extends MondayReadPort, MondayWritePort {}
