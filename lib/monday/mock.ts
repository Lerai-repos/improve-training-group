import type { MondayPort } from './port';
import type {
  MondayKlant,
  MondayQualification,
  MondayThema,
  MondayTrainer,
  MondayTraining,
  Page,
  TrainingSyncWrite,
} from './types';
import {
  DEFAULT_KLANTEN,
  DEFAULT_QUALIFICATIONS,
  DEFAULT_THEMAS,
  DEFAULT_TRAINERS,
  DEFAULT_TRAININGS,
} from './__fixtures__/domain';

export interface MockMondayData {
  trainers?: MondayTrainer[];
  themas?: MondayThema[];
  klanten?: MondayKlant[];
  trainings?: MondayTraining[];
  qualifications?: MondayQualification[];
}

/** Recorded write-back call, for test assertions. */
export interface RecordedWrite {
  itemId: string;
  sync?: TrainingSyncWrite;
  columnValues?: Record<string, unknown>;
}

export interface MockMondayPort extends MondayPort {
  /** Every writeTrainingSync / updateColumns call, in order. */
  readonly writes: RecordedWrite[];
}

/**
 * In-memory {@link MondayPort} returning NORMALIZED domain objects (it implements
 * the port; it does not emit raw Monday payloads — those live in the decoder
 * fixtures). Reads return a single page. Writes are recorded, not sent.
 */
export function createMockMondayPort(data: MockMondayData = {}): MockMondayPort {
  const trainers = data.trainers ?? DEFAULT_TRAINERS;
  const themas = data.themas ?? DEFAULT_THEMAS;
  const klanten = data.klanten ?? DEFAULT_KLANTEN;
  const trainings = data.trainings ?? DEFAULT_TRAININGS;
  const qualifications = data.qualifications ?? DEFAULT_QUALIFICATIONS;

  const writes: RecordedWrite[] = [];
  const onePage = <T>(items: T[]): Page<T> => ({ items, nextCursor: null });

  return {
    writes,
    async getTrainings() {
      return onePage(trainings);
    },
    async getTrainers() {
      return onePage(trainers);
    },
    async getThemas() {
      return onePage(themas);
    },
    async getKlanten() {
      return onePage(klanten);
    },
    async getQualifications() {
      return qualifications;
    },
    async writeTrainingSync(itemId, sync) {
      writes.push({ itemId, sync });
    },
    async updateColumns(itemId, columnValues) {
      writes.push({ itemId, columnValues });
    },
  };
}
