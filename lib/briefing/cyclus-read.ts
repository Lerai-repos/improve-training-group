/**
 * De sessies onder dezelfde Opportunity ophalen, over alle agendaborden.
 *
 * De Opportunity heeft geen relatie terug naar de agenda (gemeten 17-Sep-2026: alleen
 * Bedrijven, Contactpersoon en Aftersales), dus er wordt vanaf de agenda gezocht: één
 * gefilterde query per bord op de kolom `board_relation`. Ongeveer een seconde per bord, en dat
 * is snel genoeg voor het openen van de tab. Het hele bord doorlopen, zoals de historie doet,
 * kost er zeven.
 *
 * **Alle borden, ook een gearchiveerde jaargang.** Een cyclus kan over de jaarwisseling lopen
 * (Chrono Welluswijs: november en januari), en een gemiste sessie maakt de cyclus korter
 * zonder dat iets dat verraadt.
 */

import { BRIEFING_AGENDA_COLUMNS, DUURCATEGORIE_CYCLUS } from './columns';

import type { CyclusKandidaat } from './cyclus';

const C = BRIEFING_AGENDA_COLUMNS;

/** Een agendabord zoals de cyclus het leest. `AgendaBoard` uit de ontdekking voldoet. */
export interface CyclusBoard {
  readonly boardId: string;
  readonly gearchiveerd: boolean;
  readonly trainerRelation: string;
  readonly coTrainerRelation?: string;
  readonly themaRelation: string;
  readonly columnTypes: Readonly<Record<string, string>>;
}

export interface CyclusReader {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Ruim boven wat één Opportunity aan sessies heeft; de grootste cyclus telt er acht. */
const PAGE_SIZE = 100;
/** `items(ids:)` kapt stilzwijgend af op 25; zie `historie.ts`. */
const ITEMS_BATCH = 25;
/** Een op hol geslagen cursor mag niet eindeloos doorlopen. */
const MAX_PAGES = 5;

interface RawCell {
  readonly id: string;
  readonly text?: string | null;
  readonly date?: string | null;
  readonly linked_item_ids?: ReadonlyArray<string | number> | null;
  readonly values?: ReadonlyArray<{ readonly id: string | number }> | null;
}

interface RawItem {
  readonly id: string | number;
  readonly column_values: readonly RawCell[];
}

interface Page {
  readonly cursor: string | null;
  readonly items: readonly RawItem[];
}

/** De kolommen per bord, met het type dat ze moeten hebben. */
function kolommen(board: CyclusBoard): ReadonlyArray<readonly [string, string]> {
  return [
    [C.opportunity, 'board_relation'],
    [C.duurcategorie, 'dropdown'],
    [C.klanttitel, 'text'],
    [C.datum, 'date'],
    [C.tijden, 'text'],
    [C.locatie, 'text'],
    [C.deelnemers, 'text'],
    [board.themaRelation, 'board_relation'],
    [board.trainerRelation, 'board_relation'],
    ...(board.coTrainerRelation === undefined
      ? []
      : [[board.coTrainerRelation, 'board_relation'] as const]),
  ];
}

/**
 * Elke kolom moet op het bord staan vóór er gezocht wordt.
 *
 * Monday laat een onbekend kolom-id stil weg, en dan leest een verdwenen `DuurcategorieAG` als
 * "geen cyclus": de trainingen krijgen weer elk hun eigen briefing en niemand ziet waarom.
 */
function assertKolommen(board: CyclusBoard): void {
  const problemen = kolommen(board)
    .filter(([id, type]) => board.columnTypes[id] !== type)
    .map(([id, type]) => `${id} (verwacht ${type}, gevonden ${board.columnTypes[id] ?? 'niets'})`);
  if (problemen.length > 0) {
    throw new Error(
      `Briefing-cyclus: agendabord ${board.boardId} mist kolommen: ${problemen.join(', ')}.`
    );
  }
}

function cel(item: RawItem, id: string): RawCell {
  const gevonden = item.column_values.find((c) => c.id === id);
  if (gevonden === undefined) {
    throw new Error(
      `Briefing-cyclus: kolom "${id}" ontbreekt op item ${String(item.id)}. Een ontbrekende ` +
        'kolom is niet hetzelfde als een lege waarde.'
    );
  }
  return gevonden;
}

const tekst = (item: RawItem, id: string): string => (cel(item, id).text ?? '').trim();

function gekoppeld(item: RawItem, id: string): string[] {
  const waarde = cel(item, id);
  if (!('linked_item_ids' in waarde)) {
    throw new Error(
      `Briefing-cyclus: kolom "${id}" op item ${String(item.id)} is geen board-relatie meer.`
    );
  }
  return (waarde.linked_item_ids ?? []).map(String);
}

/** Nog zonder de namen van de trainers; die komen er in `metTrainerNamen` bij. */
function alsKandidaat(item: RawItem, board: CyclusBoard): CyclusKandidaat {
  const duur = cel(item, C.duurcategorie);
  if (!('values' in duur)) {
    throw new Error(
      `Briefing-cyclus: kolom "${C.duurcategorie}" op item ${String(item.id)} is geen dropdown meer.`
    );
  }
  const leadIds = gekoppeld(item, board.trainerRelation);
  return {
    itemId: String(item.id),
    boardId: board.boardId,
    gearchiveerd: board.gearchiveerd,
    isCyclus: (duur.values ?? []).some((v) => Number(v.id) === DUURCATEGORIE_CYCLUS),
    klanttitel: tekst(item, C.klanttitel),
    themaIds: gekoppeld(item, board.themaRelation),
    leadIds,
    // Iemand die in beide kolommen staat telt als lead, net als in de briefing zelf.
    coIds:
      board.coTrainerRelation === undefined
        ? []
        : gekoppeld(item, board.coTrainerRelation).filter((id) => !leadIds.includes(id)),
    trainerNamen: '',
    datum: (cel(item, C.datum).date ?? '').trim(),
    tijden: tekst(item, C.tijden),
    locatie: tekst(item, C.locatie),
    groepsgrootte: tekst(item, C.deelnemers),
  };
}

/** De namen van de trainers erbij: daar herkent de adviseur op of een sessie erbij hoort. */
async function metTrainerNamen(
  client: CyclusReader,
  kandidaten: readonly CyclusKandidaat[]
): Promise<CyclusKandidaat[]> {
  const ids = [...new Set(kandidaten.flatMap((k) => [...k.leadIds, ...k.coIds]))];
  const namen = new Map<string, string>();
  for (let at = 0; at < ids.length; at += ITEMS_BATCH) {
    const data = await client.query<{ items?: Array<{ id: string | number; name: string }> }>(
      'query ($ids: [ID!]) { items(ids: $ids) { id name } }',
      { ids: ids.slice(at, at + ITEMS_BATCH) }
    );
    for (const item of data.items ?? []) {
      namen.set(String(item.id), item.name);
    }
  }
  return kandidaten.map((k) => ({
    ...k,
    /**
     * Een naam die niet terugkwam wordt overgeslagen in plaats van als id getoond: dit is
     * schermtekst, geen gegeven waar iets op draait.
     */
    trainerNamen: [...k.leadIds, ...k.coIds]
      .map((id) => namen.get(id) ?? '')
      .filter((naam) => naam !== '')
      .join(', '),
  }));
}

async function zoekOpBord(
  client: CyclusReader,
  board: CyclusBoard,
  opportunityItemId: string
): Promise<CyclusKandidaat[]> {
  assertKolommen(board);
  const ids = kolommen(board)
    .map(([id]) => JSON.stringify(id))
    .join(',');
  const velden =
    `id column_values(ids:[${ids}]) { id text ` +
    '... on DateValue { date } ' +
    '... on BoardRelationValue { linked_item_ids } ' +
    '... on DropdownValue { values { id } } }';

  const gevonden: CyclusKandidaat[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < MAX_PAGES; pagina += 1) {
    const huidig: Page | undefined =
      cursor === null
        ? (
            await client.query<{ boards?: Array<{ items_page: Page }> }>(
              `query ($board: [ID!], $opp: CompareValue!) {
                 boards(ids: $board) {
                   items_page(limit: ${PAGE_SIZE}, query_params: { rules: [
                     { column_id: "${C.opportunity}", compare_value: $opp, operator: any_of }
                   ] }) { cursor items { ${velden} } }
                 }
               }`,
              { board: [board.boardId], opp: [Number(opportunityItemId)] }
            )
          ).boards?.[0]?.items_page
        : (
            await client.query<{ next_items_page?: Page }>(
              `query ($cursor: String!) {
                 next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${velden} } }
               }`,
              { cursor }
            )
          ).next_items_page;
    if (huidig === undefined) {
      throw new Error(
        `Briefing-cyclus: bord ${board.boardId} gaf geen leesbare pagina terug. "Geen andere ` +
          'sessies" melden zou hier een cyclus in losse briefings knippen.'
      );
    }
    gevonden.push(...huidig.items.map((item) => alsKandidaat(item, board)));
    cursor = huidig.cursor;
    if (cursor === null) {
      return gevonden;
    }
  }
  throw new Error(
    `Briefing-cyclus: bord ${board.boardId} was na ${MAX_PAGES} pagina's nog niet uitgelezen.`
  );
}

/**
 * Alle sessies onder dezelfde Opportunity, deze training inbegrepen.
 *
 * Leeg zonder Opportunity: dan valt er niets te bundelen en kost het ook geen query. Het
 * **cycluslabel wordt hier niet getoetst**: wie er al bij een bevestigde cyclus hoort moet die
 * cyclus blijven zien, ook als iemand dat label later weghaalt. Wanneer er gezocht wordt,
 * beslist de aanroeper — zie `readBriefingMetCyclus`.
 */
export async function readCyclusKandidaten(
  client: CyclusReader,
  opportunityItemId: string | null,
  boards: readonly CyclusBoard[]
): Promise<CyclusKandidaat[]> {
  if (opportunityItemId === null) {
    return [];
  }
  const perBord = await Promise.all(
    boards.map((board) => zoekOpBord(client, board, opportunityItemId))
  );
  return await metTrainerNamen(client, perBord.flat());
}
