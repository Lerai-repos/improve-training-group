import { z } from 'zod';

import {
  discoverAgendaBoards,
  liveAgendaBoards,
  readAgendaBoard,
  type AgendaBoard,
  type AgendaBoardSet,
  type AgendaClassification,
  type AgendaHistoryColumns,
  type BoardsQueryClient,
} from '@lib/evaluations';
import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import type { TrainingColumnMap } from '@lib/monday/decode';
import type { ItemBoardReader } from './item-board';
import type { KvStore } from './kv';
import type { RecommendationResult } from './service';

/**
 * Welke agendaborden aanbevelingen krijgen.
 *
 * Een agendabord (zie `agenda-discovery.ts`) is nog geen bord waar de engine iets mee kan.
 * Daarvoor moet er ook onze statuskolom op staan, en moeten de twee triggergroepen bestaan.
 * Gemeten 14-Sep-2026: Agenda 2026 heeft ze allebei, Agenda 2025 mist de statuskolom. Een
 * kopie van 2026 neemt ze mee, dus een nieuwe jaargang doet vanzelf mee.
 *
 * **Waarom per item opgezocht en niet door de wachtrij gedragen.** De job, het Redis-record,
 * de sweep, de repair en de failure callback kennen allemaal alleen het item-id. Het bord
 * erbij opslaan zou elk van die paden en de Lua-scripts raken. Het item weet zelf op welk
 * bord het staat, dus wordt dat gevraagd op het moment dat het ertoe doet: bij het rekenen
 * en bij het schrijven.
 */

export interface EngineBoardRules {
  /** `MONDAY_RECOMMENDATION_STATUS_COLUMN`: de kolom waar de engine zijn label schrijft. */
  readonly statusColumnId: string;
  /** De groepen waarvan een verplaatsing een berekening start. */
  readonly triggerGroupIds: readonly string[];
}

/**
 * Drie uitkomsten, en het verschil tussen de laatste twee is waar het om gaat.
 *
 * `not-served` is vastgesteld: het bord is gezien en valt erbuiten. Daarop mag een event
 * worden losgelaten. `unreadable` is niet vastgesteld: Monday gaf het item of het bord niet
 * terug. Dat kan een verwijderd item zijn, maar net zo goed een bord waarvan de toegang even
 * weg is, en dan moet het event terugkomen zodra die hersteld is. Achtergrondwerk (webhook,
 * job, statuslabel) werpt daarop, zodat het opnieuw geprobeerd wordt; zie `requireReadable`.
 */
export type ServedBoard =
  | { readonly kind: 'served'; readonly board: AgendaBoard }
  | { readonly kind: 'not-served'; readonly reden: string }
  | { readonly kind: 'unreadable'; readonly reden: string };

/** De uitkomst, of een fout als hij niet vast te stellen was. Voor werk dat opnieuw mag. */
export function requireReadable(
  served: ServedBoard
): Exclude<ServedBoard, { readonly kind: 'unreadable' }> {
  if (served.kind === 'unreadable') {
    throw new Error(`Aanbevelingen: bord niet vast te stellen — ${served.reden}`);
  }
  return served;
}

/** Waarom de engine dit agendabord niet bedient, of `null` als het in orde is. */
export function engineBoardProblem(board: AgendaBoard, rules: EngineBoardRules): string | null {
  if (board.gearchiveerd) {
    return 'het bord is gearchiveerd';
  }
  const statusType = board.columnTypes[rules.statusColumnId];
  if (statusType !== 'status') {
    return statusType === undefined
      ? `de statuskolom voor aanbevelingen (${rules.statusColumnId}) staat niet op het bord`
      : `de statuskolom voor aanbevelingen (${rules.statusColumnId}) is geen statuskolom meer`;
  }
  const ontbreekt = rules.triggerGroupIds.filter((g) => !board.groupIds.includes(g));
  if (ontbreekt.length > 0) {
    return `de groep(en) ${ontbreekt.join(', ')} staan niet op het bord, dus een verplaatsing start niets`;
  }
  return null;
}

/**
 * De kolommen van de engine op dit bord.
 *
 * Alleen de relaties verschillen per jaargang; de rest heeft op elk agendabord hetzelfde id.
 * Die komen dus van Agenda 2026, en de drie relaties van het bord zelf.
 */
export function trainingColumnsFor(board: AgendaHistoryColumns): TrainingColumnMap {
  return {
    ...AGENDA_2026_COLUMNS,
    trainerRelation: board.trainerRelation,
    coTrainerRelation: board.coTrainerRelation,
    themaRelation: board.themaRelation,
  };
}

/**
 * De uitkomst voor een item waarvan het bord geen aanbevelingen krijgt.
 *
 * Niet opnieuw te proberen: het bord verandert niet door het nog eens te vragen. De job legt
 * dit vast als FOUT, en de statusschrijver slaat het bord over — zo stopt de wachtrij in
 * plaats van tot de dead-letter queue door te proberen.
 */
export function notServedResult(reden: string): RecommendationResult {
  return {
    ok: false,
    resultStatus: 'FOUT',
    failure: {
      stage: 'load_training',
      message: `Dit bord krijgt geen aanbevelingen: ${reden}`,
      retryable: false,
    },
    partial: {},
  };
}

export interface EngineBoards {
  /** Bedient de engine dit bord? Werpt als dat niet vast te stellen is. */
  check(boardId: string): Promise<ServedBoard>;
  /** Hetzelfde, voor het bord waar dit item op staat. */
  forItem(itemId: string): Promise<ServedBoard>;
  /** De actieve agendaborden: welke de engine bedient, en waarom de rest niet. */
  list(): Promise<{
    readonly served: readonly AgendaBoard[];
    readonly refused: readonly { readonly board: AgendaBoard; readonly reden: string }[];
  }>;
}

export interface EngineBoardsDeps {
  readonly kv: KvStore;
  readonly client: BoardsQueryClient;
  readonly items: ItemBoardReader;
  readonly rules: EngineBoardRules;
  /** `MONDAY_AGENDA_BOARD_ID`, of `null` op productie. */
  readonly override: string | null;
  /** Te vervangen in tests. */
  readonly discover?: (client: BoardsQueryClient) => Promise<AgendaBoardSet>;
  readonly readBoard?: (
    client: BoardsQueryClient,
    boardId: string
  ) => Promise<AgendaClassification>;
}

/**
 * Een kwartier, want dit staat in het pad van elke webhook, job en werklastscan.
 *
 * Alle borden afzoeken kost gemeten 4,6 seconden en de werklastcron draait elke minuut. Wat
 * een kwartier oud mag zijn: een bord dat net gearchiveerd is krijgt nog even labels, en een
 * nieuw bord wordt ook zonder cache herkend, via de terugval in `check`.
 */
export const AGENDA_BOARDS_CACHE_TTL_MS = 15 * 60 * 1000;

const CACHE_KEY = 'agenda-boards:v1';

const boardSchema = z.object({
  boardId: z.string(),
  jaargang: z.string(),
  trainerRelation: z.string(),
  coTrainerRelation: z.string().optional(),
  themaRelation: z.string(),
  klantRelation: z.string(),
  ieCode: z.string(),
  datum: z.string(),
  minimumItems: z.number(),
  naam: z.string(),
  gearchiveerd: z.boolean(),
  groupIds: z.array(z.string()),
  columnTypes: z.record(z.string(), z.string()),
});

const setSchema = z.object({
  boards: z.array(boardSchema),
  rejected: z.array(z.object({ boardId: z.string(), naam: z.string(), reden: z.string() })),
});

/** Onleesbaar is een misser, geen fout: dan wordt er opnieuw gezocht. */
function decode(raw: string | null): AgendaBoardSet | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = setSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Bij de testoverride telt alleen die ene kopie, net als in de andere jobs. */
function restrict(set: AgendaBoardSet, override: string | null): AgendaBoardSet {
  if (override === null) {
    return set;
  }
  return {
    boards: set.boards.filter((b) => b.boardId === override),
    rejected: set.rejected.filter((r) => r.boardId === override),
  };
}

export function createEngineBoards(deps: EngineBoardsDeps): EngineBoards {
  const discover = deps.discover ?? discoverAgendaBoards;
  const readBoard = deps.readBoard ?? readAgendaBoard;
  let pending: Promise<AgendaBoardSet> | null = null;

  const judge = (board: AgendaBoard): ServedBoard => {
    const reden = engineBoardProblem(board, deps.rules);
    return reden === null ? { kind: 'served', board } : { kind: 'not-served', reden };
  };

  /**
   * Bewust NIET `loadAgendaBoards`: die weigert als Agenda 2025 verdwijnt, en dat is terecht
   * voor de evaluatiecijfers maar geen reden om de aanbevelingen op 2026 stil te leggen.
   */
  async function load(): Promise<AgendaBoardSet> {
    const cached = decode(await deps.kv.get(CACHE_KEY).catch(() => null));
    if (cached !== null) {
      return restrict(cached, deps.override);
    }
    const found = await discover(deps.client);
    // Best effort: een cache die niet geschreven wordt kost een zoekactie, geen juistheid.
    await deps.kv
      .set(CACHE_KEY, JSON.stringify(found), { ttlMs: AGENDA_BOARDS_CACHE_TTL_MS })
      .catch(() => undefined);
    return restrict(found, deps.override);
  }

  function boards(): Promise<AgendaBoardSet> {
    if (pending === null) {
      const attempt = load();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) {
          pending = null;
        }
      });
    }
    return pending;
  }

  async function check(boardId: string): Promise<ServedBoard> {
    if (deps.override !== null && boardId !== deps.override) {
      return {
        kind: 'not-served',
        reden: 'alleen het testbord uit MONDAY_AGENDA_BOARD_ID doet mee',
      };
    }
    const set = await boards();
    const known = set.boards.find((b) => b.boardId === boardId);
    if (known !== undefined) {
      return judge(known);
    }
    const rejected = set.rejected.find((r) => r.boardId === boardId);
    if (rejected !== undefined) {
      return { kind: 'not-served', reden: rejected.reden };
    }
    /**
     * Niet in de lijst: misschien een bord dat na het vullen van de cache is gedupliceerd.
     * Dat ene bord wordt dan live gekeurd, zodat een nieuwe jaargang niet een kwartier hoeft
     * te wachten.
     */
    const live = await readBoard(deps.client, boardId);
    if (live.kind === 'agenda') {
      return judge(live.board);
    }
    if (live.kind === 'niet-gevonden') {
      return { kind: 'unreadable', reden: `bord ${boardId} kwam niet terug van Monday` };
    }
    return {
      kind: 'not-served',
      reden: live.kind === 'onbruikbaar' ? live.rejected.reden : 'dit bord is geen agendabord',
    };
  }

  return {
    check,
    async forItem(itemId) {
      const boardId = await deps.items.readBoardId(itemId);
      if (boardId === null) {
        return {
          kind: 'unreadable',
          reden:
            `item ${itemId} kwam niet terug: verwijderd, of op een bord dat (even) niet met ` +
            'Automatisering is gedeeld',
        };
      }
      return check(boardId);
    },
    async list() {
      const served: AgendaBoard[] = [];
      const refused: { board: AgendaBoard; reden: string }[] = [];
      for (const board of liveAgendaBoards(await boards())) {
        const reden = engineBoardProblem(board, deps.rules);
        if (reden === null) {
          served.push(board);
        } else {
          refused.push({ board, reden });
        }
      }
      return { served, refused };
    },
  };
}
