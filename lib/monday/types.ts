import type { Qualification } from '@lib/calc';

/**
 * Normalized DOMAIN shapes returned by the {@link MondayPort}. These are already
 * decoded from Monday's raw column payloads — no `board_relation`/`mirror`
 * quirks leak past this boundary. External ids are Monday item/board/group ids
 * as strings.
 */

/** Which board (and page) to read. */
export interface MondayBoardScope {
  boardId: string;
  /** Opaque cursor for incremental paging; null/undefined = first page. */
  cursor?: string | null;
  limit?: number;
}

/** One page of results plus the cursor to fetch the next. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MondayTrainer {
  externalItemId: string;
  externalBoardId: string;
  naam: string;
  adres: string | null;
  email: string | null;
  telefoon: string | null;
  /** The raw Monday group id — stored on every trainer (ingestion is never filtered). */
  mondayGroup: string | null;
  /**
   * Rate schedule key, resolved downstream from the group-policy map. Null when
   * the group is unmapped (variabel/unset) — never blocks the import.
   */
  rateKey: string | null;
  /**
   * The `Uurtarief` cell as Monday rendered it, or null when empty or unconfigured.
   *
   * Raw on purpose: parsing it needs the euro parser and the per-uur bounds, which live
   * with the pricing rather than with the decoder. See `lib/trainers/uurtarief.ts`.
   */
  uurtariefRaw: string | null;
}

export interface MondayThema {
  externalItemId: string;
  externalBoardId: string;
  thema: string;
}

export interface MondayKlant {
  externalItemId: string;
  klantnaam: string;
}

export interface MondayTraining {
  externalItemId: string;
  externalBoardId: string;
  externalGroupId: string | null;
  datum: string | null;
  tijd: string | null;
  taal: string | null;
  duurTraining: number | null;
  status: string | null;
  ieCode: string | null;
  omzetCents: number | null;
  locatie: string | null;
  label: string | null;
  /** Company name from the Bedrijf mirror (via Opportunities). */
  companyName: string | null;
  /** Linked Monday item ids (decoded from board_relation). */
  trainerExternalIds: string[];
  themaExternalIds: string[];
  /**
   * Client links. On the real board the client is NOT a board_relation on the
   * training — it's reached by a mirror through Opportunities, so a stable
   * client id needs that traversal (connection phase). The offline mock/seed
   * populates this directly; the raw decoder leaves it empty and uses companyName.
   */
  klantExternalIds: string[];
}

export interface MondayQualification {
  trainerExternalId: string;
  themaExternalId: string;
  qualification: Qualification;
  /** Which colour board_relation column this observation came from (provenance). */
  sourceColumn?: string | null;
}

/**
 * Write-back payload for a training. Fields are DOMAIN-named; the future GraphQL
 * adapter maps `backendRecordId`/`appUrl` onto Monday's legacy Airtable-named
 * columns (`text_mkztmvtv` / `text_mkzwwat9`).
 */
export interface TrainingSyncWrite {
  backendRecordId: string;
  appUrl: string;
  recommendationStatus: string;
  trainerStatus: string;
}
