/**
 * Where the computed trainer×thema statistics live between the nightly job and the
 * engine.
 *
 * A Monday board was the original design (`02-datamodel-monday.md:104`), for
 * visibility: ITG could open it and check a strange average. That argument did not
 * survive contact with the recommendations view, which now shows all five figures per
 * trainer per training — and the same doc says the distinction that actually matters
 * belongs "expliciet in de aanbevelingen-view". What the board added over this was
 * browsing pairs outside a training, against the cost of a writer, a diff, a seed, orphan
 * rules and a board ITG had to create first.
 *
 * So: one key, rewritten whole each night, read whole by the engine.
 *
 * The whole set in one value is deliberate rather than lazy. The engine needs every
 * candidate trainer's rows across ALL their themes to compute an overall average, so
 * "fetch the rows I need" is very nearly "fetch everything"; splitting it would add
 * round trips and a partial-read failure mode to save nothing. It also makes the write
 * atomic — there is no moment where half the statistics are new.
 */

import { z } from 'zod';

import type { KvStore } from '@lib/recommend/kv';
import type { BoardQualification, TrainerThemaStatRow } from './types';

/**
 * `v1` is in the key, not just the payload: a shape change writes to a different key,
 * so an old engine cannot read a new record and vice versa. Cheaper than a migration
 * and impossible to get half-right.
 */
const KEY = 'evalstats:v1';

/**
 * 30 days. Long enough that a fortnight of failed crons does not erase the statistics,
 * short enough that a permanently dead job eventually stops serving numbers nobody is
 * maintaining. The engine surfaces the age, so stale-but-present is visible rather than
 * silent.
 */
export const STATS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rows are stored as TUPLES, not objects.
 *
 * At ~2.200 rows the object form is ~250 KB of repeated key names; the tuple form is
 * closer to 60 KB. That matters because this value is fetched on the recommendation
 * path. The order is fixed by the schema below and validated on read, so a field added
 * in the wrong position fails loudly instead of shifting every value one place left.
 */
const rowTuple = z.tuple([
  z.string().min(1), // trainerExternalId
  z.string().min(1), // themaExternalId
  z.number().finite().nullable(), // weightedAvg — null means "no grades", never 0
  z.number().int().nonnegative(), // evaluationCount
  z.number().int().nonnegative(), // timesTaught
  z.enum(['Groen', 'Oranje', 'Rood', 'Grijs', 'Conflict', 'Geen']), // qualification
]);

const recordSchema = z.object({
  v: z.literal(1),
  /** ISO instant the job finished. Read back so staleness can be reported. */
  writtenAt: z.string().min(1),
  /** `YYYY-MM-DD` in Europe/Amsterdam that the completion rule used. */
  today: z.string().min(1),
  /**
   * What each source contributed, so the NEXT run can notice a collapse.
   *
   * Carried inside the record rather than in a sibling key, which removes a whole class
   * of bug: the baseline cannot advance without the data it describes, a refused run
   * cannot half-update it, and there is no first-run bootstrap to get wrong. Keys are
   * per document (`sheet:nl`) plus the derived totals.
   */
  sources: z.record(z.string(), z.number()),
  rows: z.array(rowTuple),
});

export interface StatsSnapshot {
  readonly rows: readonly TrainerThemaStatRow[];
  readonly writtenAt: string;
  readonly today: string;
  readonly sources: Record<string, number>;
}

/** Everything a write needs; the same shape `read` gives back. */
export type StatsWrite = Omit<StatsSnapshot, 'rows'> & { rows: readonly TrainerThemaStatRow[] };

export interface StatsStore {
  /** The whole set, or null when nothing has ever been written. */
  read(): Promise<StatsSnapshot | null>;
  write(snapshot: StatsWrite): Promise<void>;
  /** Bytes of the serialized record — reported by the job, so growth is visible. */
  sizeOf(rows: readonly TrainerThemaStatRow[]): number;
}

function encode(snapshot: StatsWrite): string {
  return JSON.stringify({
    v: 1,
    writtenAt: snapshot.writtenAt,
    today: snapshot.today,
    sources: snapshot.sources,
    rows: snapshot.rows.map((row) => [
      row.trainerExternalId,
      row.themaExternalId,
      row.weightedAvg,
      row.evaluationCount,
      row.timesTaught,
      row.qualification,
    ]),
  });
}

export function createStatsStore(kv: KvStore, ttlMs: number = STATS_TTL_MS): StatsStore {
  return {
    async read(): Promise<StatsSnapshot | null> {
      const raw = await kv.get(KEY);
      if (raw === null) {
        return null;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        // A corrupt record must not read as "no statistics": that is
        // indistinguishable from a trainer having never been evaluated, and the engine
        // would serve confident zeroes.
        throw new Error(`${KEY} is not valid JSON — refusing to serve partial statistics`);
      }

      const parsed = recordSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(
          `${KEY} has an unreadable shape (${parsed.error.issues[0]?.message ?? 'unknown'}) — ` +
            `refusing to serve partial statistics`
        );
      }

      const rows: TrainerThemaStatRow[] = parsed.data.rows.map(
        ([trainerExternalId, themaExternalId, weightedAvg, evaluationCount, timesTaught, qualification]) => ({
          trainerExternalId,
          themaExternalId,
          weightedAvg,
          evaluationCount,
          timesTaught,
          qualification: qualification satisfies BoardQualification,
        })
      );

      const keys = rows.map((row) => `${row.trainerExternalId}|${row.themaExternalId}`);
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate !== undefined) {
        throw new Error(`${KEY} holds two rows for ${duplicate} — refusing an ambiguous statistic`);
      }

      return {
        rows,
        writtenAt: parsed.data.writtenAt,
        today: parsed.data.today,
        sources: parsed.data.sources,
      };
    },

    async write(snapshot): Promise<void> {
      await kv.set(KEY, encode(snapshot), { ttlMs });
    },

    sizeOf(rows): number {
      return Buffer.byteLength(encode({ rows, writtenAt: '', today: '', sources: {} }), 'utf8');
    },
  };
}
