/**
 * Welke agendaborden er zijn: ontdekt aan hun kolommen, niet uit een vaste lijst.
 *
 * ITG dupliceert elk jaar het agendabord. Een kopie houdt elk kolom-id, groep-id en elke
 * relatie, maar krijgt een nieuw bord-id. Met een vaste lijst deed de nieuwe jaargang
 * nergens aan mee, en zonder foutmelding: de briefing-tab weigerde zijn trainingen, de
 * evaluaties telden ze niet, en de dagjob sloeg ze over.
 *
 * **Een agendabord is een bord met een relatie naar het trainersbord én naar het
 * Thema's-bord.** Op 14-Sep-2026 gemeten over alle 90 borden die het token ziet: precies
 * Agenda 2026 en Agenda 2025 voldoen. Niet op naam: een naam is vrije tekst, en "Agenda"
 * staat ook op de subitemborden.
 *
 * Monday's eigen status bepaalt wat een bord krijgt:
 *
 * - **actief**: alles, dus briefings, de dagjob en de dagelijkse controle
 * - **gearchiveerd**: alleen de historie (evaluatiecijfers, `Vaste klant`), want een
 *   afgesloten jaar hoort zijn cijfers te houden
 * - **verwijderd**: niets
 *
 * Een bord dat op een agenda lijkt maar een kolom mist, wordt NIET gebruikt en komt als
 * `rejected` terug. Dan wordt het een melding op het Systeem-bord in plaats van een job die
 * halverwege omvalt.
 */

import {
  AGENDA_2026_PRODUCTION_BOARD,
  agendaBoardId,
  THEMAS_BOARD,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import { assertColumns } from '@lib/monday/schema-check';

import {
  AGENDA_2026_HISTORY,
  AGENDA_HISTORY_BOARDS,
  agendaHistoryExpectedColumns,
  type AgendaHistoryColumns,
} from './agenda-columns';

import type { BoardMeta } from '@lib/monday/graphql-client';

export interface AgendaBoard extends AgendaHistoryColumns {
  readonly naam: string;
  /** Gearchiveerd in Monday: telt mee voor de historie, krijgt geen nieuw werk. */
  readonly gearchiveerd: boolean;
  /** De groep-ids op het bord. De aanbevelingen hebben hun triggergroepen nodig. */
  readonly groupIds: readonly string[];
  /** Kolom-id → kolomtype, zodat een job kan nagaan of een kolom die hij schrijft bestaat. */
  readonly columnTypes: Readonly<Record<string, string>>;
}

/** Een bord dat op een agenda lijkt, maar niet te gebruiken is. */
export interface RejectedAgendaBoard {
  readonly boardId: string;
  readonly naam: string;
  readonly reden: string;
}

export interface AgendaBoardSet {
  readonly boards: readonly AgendaBoard[];
  readonly rejected: readonly RejectedAgendaBoard[];
}

export interface DiscoveredColumn {
  readonly id: string;
  readonly type: string;
  readonly settings_str: string | null;
}

/** Een bord zoals Monday het teruggeeft, met zoveel kolommen als er zijn opgevraagd. */
export interface DiscoveredBoard {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly type: string | null;
  readonly items_count: number | null;
  readonly columns: readonly DiscoveredColumn[];
  /** Leeg als de groepen niet zijn opgevraagd, zoals bij het afzoeken van alle borden. */
  readonly groupIds: readonly string[];
}

export type AgendaClassification =
  | { readonly kind: 'agenda'; readonly board: AgendaBoard }
  | { readonly kind: 'onbruikbaar'; readonly rejected: RejectedAgendaBoard }
  | { readonly kind: 'geen-agenda' }
  /**
   * Monday gaf het bord niet terug: niet gedeeld, verwijderd, of even onleesbaar. Dat is iets
   * anders dan "geen agenda", en een job die hierop stopt zou een event voorgoed laten vallen.
   */
  | { readonly kind: 'niet-gevonden' };

/** Alleen wat er gelezen wordt; het antwoord wordt hieronder zelf gecontroleerd. */
export interface BoardsQueryClient {
  query(document: string, variables?: Record<string, unknown>): Promise<unknown>;
}

/** De borden die we gemeten hebben. Ze moeten altijd gevonden worden; zie `resolveAgendaBoards`. */
export const KNOWN_AGENDA_BOARD_IDS: ReadonlySet<string> = new Set(
  AGENDA_HISTORY_BOARDS.map((b) => b.boardId)
);

const KNOWN_FLOORS: ReadonlyMap<string, number> = new Map(
  AGENDA_HISTORY_BOARDS.map((b) => [b.boardId, b.minimumItems])
);

/**
 * De co-trainerkolom heeft een eigen, door ons gekozen id; elke kopie van 2026 neemt hem mee.
 * Zo is hij te onderscheiden van de leadrelatie, die ook naar het trainersbord wijst.
 */
const CO_TRAINER_COLUMN = AGENDA_2026_HISTORY.coTrainerRelation;

/** Monday geeft maximaal zoveel borden per pagina terug. */
const PAGE_SIZE = 100;
/** Ruim boven de 90 borden van nu; een telling die hier doorheen loopt is een fout. */
const MAX_PAGES = 20;

const BOARD_FIELDS =
  'id name state type items_count groups { id } columns { id type settings_str }';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** Monday geeft ids soms als getal terug; alles hierna vergelijkt strings. */
const asText = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

function parseColumn(raw: unknown): DiscoveredColumn[] {
  if (!isRecord(raw)) {
    return [];
  }
  const id = asText(raw.id);
  const type = asText(raw.type);
  if (id === null || type === null) {
    return [];
  }
  return [
    { id, type, settings_str: typeof raw.settings_str === 'string' ? raw.settings_str : null },
  ];
}

function parseGroupId(raw: unknown): string[] {
  const id = isRecord(raw) ? asText(raw.id) : null;
  return id === null ? [] : [id];
}

/**
 * Het antwoord op een `boards`-vraag, gecontroleerd.
 *
 * Werpt als er geen lijst terugkomt: "geen borden" en "onleesbaar antwoord" horen niet
 * hetzelfde te lezen, want het eerste betekent hier "er zijn geen agendaborden".
 */
function parseBoards(data: unknown): DiscoveredBoard[] {
  if (!isRecord(data) || !Array.isArray(data.boards)) {
    throw new Error('Agendaborden zoeken: Monday gaf geen lijst met borden terug.');
  }
  return data.boards.flatMap((raw: unknown): DiscoveredBoard[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const id = asText(raw.id);
    const name = asText(raw.name);
    if (id === null || name === null) {
      return [];
    }
    return [
      {
        id,
        name,
        state: asText(raw.state) ?? '',
        type: asText(raw.type),
        items_count: typeof raw.items_count === 'number' ? raw.items_count : null,
        columns: Array.isArray(raw.columns) ? raw.columns.flatMap(parseColumn) : [],
        groupIds: Array.isArray(raw.groups) ? raw.groups.flatMap(parseGroupId) : [],
      },
    ];
  });
}

/** De borden waar een relatie naar wijst, uit de `settings_str` van die kolom. */
function relationTargets(settings: string | null): readonly string[] {
  if (settings === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(settings);
    if (!isRecord(parsed) || !Array.isArray(parsed.boardIds)) {
      return [];
    }
    return parsed.boardIds.map(String);
  } catch {
    return [];
  }
}

/**
 * De relaties die naar precies dit ene bord wijzen.
 *
 * Precies één doelbord: een relatie die naar meerdere borden wijst is niet de trainer- of
 * themakolom, en de kolomcontrole verderop zou haar toch weigeren.
 */
function relationsTo(board: DiscoveredBoard, target: string): string[] {
  return board.columns
    .filter((c) => c.type === 'board_relation')
    .filter((c) => {
      const targets = relationTargets(c.settings_str);
      return targets.length === 1 && targets[0] === target;
    })
    .map((c) => c.id);
}

/** `Agenda 2027` → `2027`; zonder jaartal in de naam het bord-id. */
function jaargangOf(board: DiscoveredBoard): string {
  const jaren = board.name.match(/\b20\d{2}\b/g);
  return jaren === null ? board.id : jaren[jaren.length - 1];
}

function asMeta(board: DiscoveredBoard): BoardMeta {
  return {
    id: board.id,
    name: board.name,
    groups: [],
    columns: board.columns.map((c) => ({
      id: c.id,
      title: c.id,
      type: c.type,
      settings_str: c.settings_str,
    })),
    items_count: board.items_count,
  };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Is dit een agendabord, en zo ja, met welke kolommen? */
export function classifyAgendaBoard(board: DiscoveredBoard): AgendaClassification {
  if (board.type !== 'board' || board.state === 'deleted') {
    return { kind: 'geen-agenda' };
  }
  const trainers = relationsTo(board, TRAINERS_BOARD);
  const themas = relationsTo(board, THEMAS_BOARD);
  if (trainers.length === 0 || themas.length === 0) {
    return { kind: 'geen-agenda' };
  }

  const weiger = (reden: string): AgendaClassification => ({
    kind: 'onbruikbaar',
    rejected: { boardId: board.id, naam: board.name.trim(), reden },
  });

  if (themas.length > 1) {
    return weiger(
      `er zijn ${themas.length} relaties naar het Thema's-bord, dus welke het thema van de ` +
        'training draagt staat nergens'
    );
  }
  const co = trainers.find((id) => id === CO_TRAINER_COLUMN);
  const leads = trainers.filter((id) => id !== CO_TRAINER_COLUMN);
  if (leads.length !== 1) {
    return weiger(
      `er zijn ${leads.length} relaties naar het trainersbord naast Co-trainer(s), dus welke ` +
        'de leadtrainer draagt staat nergens'
    );
  }

  const columns: AgendaHistoryColumns = {
    boardId: board.id,
    jaargang: jaargangOf(board),
    trainerRelation: leads[0],
    ...(co === undefined ? {} : { coTrainerRelation: co }),
    themaRelation: themas[0],
    // Deze drie heten op elk agendabord hetzelfde, gemeten op 2025 en 2026.
    klantRelation: AGENDA_2026_HISTORY.klantRelation,
    ieCode: AGENDA_2026_HISTORY.ieCode,
    datum: AGENDA_2026_HISTORY.datum,
    /**
     * Een nieuw bord krijgt geen ondergrens.
     *
     * De ondergrens vangt een bord dat plots te weinig rijen teruggeeft, en daarvoor moet je
     * weten hoeveel het er hoort te hebben. Een verse 2027 heeft er legitiem een handvol.
     */
    minimumItems: KNOWN_FLOORS.get(board.id) ?? 0,
  };

  try {
    assertColumns(asMeta(board), agendaHistoryExpectedColumns(columns));
  } catch (error) {
    return weiger(`de kolommen kloppen niet (${message(error)})`);
  }

  return {
    kind: 'agenda',
    board: {
      ...columns,
      naam: board.name.trim(),
      gearchiveerd: board.state === 'archived',
      groupIds: board.groupIds,
      columnTypes: Object.fromEntries(board.columns.map((c) => [c.id, c.type])),
    },
  };
}

export function classifyAgendaBoards(boards: readonly DiscoveredBoard[]): AgendaBoardSet {
  const found: AgendaBoard[] = [];
  const rejected: RejectedAgendaBoard[] = [];
  for (const board of boards) {
    const uit = classifyAgendaBoard(board);
    if (uit.kind === 'agenda') {
      found.push(uit.board);
    } else if (uit.kind === 'onbruikbaar') {
      rejected.push(uit.rejected);
    }
  }
  return { boards: found, rejected };
}

/** De borden die nieuw werk krijgen. */
export function liveAgendaBoards(set: AgendaBoardSet): readonly AgendaBoard[] {
  return set.boards.filter((b) => !b.gearchiveerd);
}

/**
 * Alle agendaborden die het token kan zien.
 *
 * Twee stappen, omdat alle kolommen van alle borden ophalen zwaar is. Eerst alleen de
 * relatiekolommen, om de kandidaten te vinden; dan de volledige kolommen van alleen die
 * kandidaten, om ze te keuren.
 */
export async function discoverAgendaBoards(client: BoardsQueryClient): Promise<AgendaBoardSet> {
  const candidates: string[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const boards = parseBoards(
      await client.query(
        `query ($page: Int!) { boards(limit: ${PAGE_SIZE}, page: $page, state: all) { ` +
          'id name state type items_count columns(types: [board_relation]) { id type settings_str } } }',
        { page }
      )
    );
    for (const board of boards) {
      if (classifyAgendaBoard(board).kind !== 'geen-agenda') {
        candidates.push(board.id);
      }
    }
    if (boards.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new Error(
      `Agendaborden zoeken: na ${MAX_PAGES} pagina's nog niet alle borden gezien. Een ` +
        'onvolledige lijst zou een agendabord stilzwijgend overslaan.'
    );
  }
  if (candidates.length === 0) {
    return { boards: [], rejected: [] };
  }

  return classifyAgendaBoards(
    parseBoards(
      await client.query(`query ($ids: [ID!]) { boards(ids: $ids) { ${BOARD_FIELDS} } }`, {
        ids: candidates,
      })
    )
  );
}

/** Eén bord keuren, zonder alle borden af te lopen. Voor de briefing-tab. */
export async function readAgendaBoard(
  client: BoardsQueryClient,
  boardId: string
): Promise<AgendaClassification> {
  const [board] = parseBoards(
    await client.query(`query ($ids: [ID!]) { boards(ids: $ids) { ${BOARD_FIELDS} } }`, {
      ids: [boardId],
    })
  );
  return board === undefined ? { kind: 'niet-gevonden' } : classifyAgendaBoard(board);
}

/**
 * De testoverride, of `null` op productie.
 *
 * `MONDAY_AGENDA_BOARD_ID` richt de pijplijn op een kopie. Staat hij aan, dan werkt alles op
 * alleen die kopie: echte en testtrainingen in één toekenning kunnen een gedeelde code aan
 * een testrij koppelen.
 */
export function agendaBoardOverride(): string | null {
  const board = agendaBoardId();
  return board === AGENDA_2026_PRODUCTION_BOARD ? null : board;
}

/**
 * Wat de jobs mogen gebruiken, of een fout.
 *
 * **Een gemeten bord dat niet (meer) gevonden wordt is een fout, geen kleinere lijst.** Zet
 * iemand het delen met Automatisering uit, of breekt een kolom, dan zou de historie zonder
 * dat bord verder rekenen, en verdwijnen de cijfers van dat hele jaar zonder melding.
 */
export function resolveAgendaBoards(
  found: AgendaBoardSet,
  override: string | null
): AgendaBoardSet {
  if (override !== null) {
    const board = found.boards.find((b) => b.boardId === override);
    if (board === undefined) {
      const reden = found.rejected.find((r) => r.boardId === override)?.reden;
      throw new Error(
        `MONDAY_AGENDA_BOARD_ID wijst naar ${override}, maar dat is geen bruikbaar agendabord` +
          (reden === undefined ? ' (niet gevonden of niet gedeeld).' : `: ${reden}.`)
      );
    }
    return { boards: [board], rejected: [] };
  }

  const ontbreekt = [...KNOWN_AGENDA_BOARD_IDS].filter(
    (id) => !found.boards.some((b) => b.boardId === id)
  );
  if (ontbreekt.length > 0) {
    const redenen = ontbreekt.map((id) => {
      const reden = found.rejected.find((r) => r.boardId === id)?.reden;
      return `${id} (${reden ?? 'niet gevonden, verwijderd of niet meer gedeeld met Automatisering'})`;
    });
    throw new Error(
      `Agendaborden: ${redenen.join('; ')}. Zonder dat bord zouden de evaluatiecijfers van ` +
        'dat jaar stil verdwijnen, dus er wordt niets gedaan.'
    );
  }
  return found;
}

/** Ontdekken en de regels hierboven toepassen. Wat elke job aanroept. */
export async function loadAgendaBoards(client: BoardsQueryClient): Promise<AgendaBoardSet> {
  return resolveAgendaBoards(await discoverAgendaBoards(client), agendaBoardOverride());
}
