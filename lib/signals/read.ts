import { THEMAS_BOARD, TRAINERS_BOARD } from '@lib/monday/board-config';
import { THEMAS_COLUMNS } from '@lib/briefing/columns';
import { readLabelRows } from '@lib/labels/read';
import { assertColumns } from '@lib/monday/schema-check';
import { agendaTrainerRelations, reportAgendaBoards } from '@lib/report/agenda-boards';

import { CLOSED_BY_CHECK, SIGNAL_COLUMNS, SIGNAL_EXPECTED_COLUMNS } from './columns';

import type { ExpectedColumn } from '@lib/monday/board-config';
import type { AgendaHistoryColumns } from '@lib/evaluations';
import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { AgendaUsage, ThemaRecord } from './findings';
import type { ExistingSignal } from './reconcile';

/** De labelkolom op de agenda. Zelfde id op beide jaargangen. */
const AGENDA_LABEL_COLUMN = 'status23';

/**
 * **Monday laat een onbekend kolom-id stilzwijgend weg uit `column_values`.** Geen fout, geen
 * lege cel — de sleutel is er gewoon niet, en `text` leest dan als lege string.
 *
 * Dat is voor déze job giftiger dan elders. Verdwijnt de labelkolom, dan is elk label ineens
 * leeg, worden er nul labelvondsten gedaan, en concludeert de opruimstap dat alles is opgelost
 * — precies de toestand waar `checked` in `reconcile.ts` voor bestaat, maar dan binnengekomen
 * langs een andere deur, want de controle *slaagde* immers. Verdwijnt de concept-kolom, dan
 * gebeurt het omgekeerde: álle 89 gebruikte thema's lijken leeg en er komen 89 meldingen bij.
 *
 * Vandaar: precies de kolommen die deze job LEEST, met hun type, en voor de relatie ook waar
 * hij naartoe wijst — een relatie die naar een ander bord is omgehangen houdt id én type.
 *
 * Bewust smaller dan `agendaHistoryExpectedColumns`: die eist ook de trainer-, klant- en
 * IE-codekolom. Daar hangt de dagelijkse controle niet vanaf, en erop weigeren zou de controle
 * stilleggen om een kolom die ze niet aanraakt.
 */
function agendaUsageExpectedColumns(board: AgendaHistoryColumns): readonly ExpectedColumn[] {
  const trainer = (id: string): ExpectedColumn => ({
    id,
    type: 'board_relation',
    settingsIncludes: [`"boardIds":[${TRAINERS_BOARD}]`],
  });
  return [
    { id: AGENDA_LABEL_COLUMN, type: 'status' },
    {
      id: board.themaRelation,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${THEMAS_BOARD}]`],
    },
    ...trainerColumns(board.boardId).map(trainer),
  ];
}

/**
 * De trainerkolommen van dit bord: lead en, waar hij bestaat, co-trainer.
 *
 * **Allebei**, want een co-trainer is net zo goed een verwijzing die kan verwijzen naar een
 * verwijderd item — en op 2025 bestaat de co-kolom niet, dus de lijst is per jaargang anders.
 */
function trainerColumns(boardId: string): readonly string[] {
  const relaties = agendaTrainerRelations(boardId);
  if (relaties === null) {
    return [];
  }
  return relaties.co === null ? [relaties.lead] : [relaties.lead, relaties.co];
}

const THEMA_EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { id: THEMAS_COLUMNS.conceptInhoud, type: 'long_text' },
];

/** Het bord ophalen en meteen keuren. Geeft `items_count` terug voor de volledigheidscontrole. */
async function checkedSchema(
  client: MondayGraphQLClient,
  boardId: string,
  expected: readonly ExpectedColumn[]
): Promise<number | null> {
  const meta: readonly BoardMeta[] = await client.getSchema([boardId]);
  const board = meta[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden of niet toegankelijk.`);
  }
  assertColumns(board, expected);
  return board.items_count ?? null;
}

interface Cell {
  id: string;
  text?: string | null;
  linked_item_ids?: Array<string | number> | null;
  /**
   * Beide vormen toegestaan, met opzet.
   *
   * `CheckboxValue.checked` komt op API 2026-07 terug als een echte **boolean** — gemeten,
   * niet aangenomen. De losse `value`-JSON van diezelfde kolom draagt hem als string, en
   * oudere versies deden dat ook in het typed veld. Één vorm hard veronderstellen levert geen
   * fout op maar een vinkje dat altijd als "niet aangevinkt" leest, en dan doet afvinken
   * niets: de melding blijft meetellen als openstaand en de controle blijft hem elke nacht
   * opnieuw willen afvinken.
   */
  checked?: boolean | string | null;
}

interface Row {
  id: string;
  name?: string;
  updated_at?: string | null;
  group?: { id: string } | null;
  column_values?: Cell[] | null;
}

const byId = (row: Row): Map<string, Cell> =>
  new Map((row.column_values ?? []).map((c) => [c.id, c]));

const textOf = (cell: Cell | undefined): string => (cell?.text ?? '').trim();

/** Of een checkbox aan staat, ongeacht of Monday een boolean of een string teruggeeft. */
export function isChecked(cell: { checked?: boolean | string | null } | undefined): boolean {
  return cell?.checked === true || cell?.checked === 'true';
}

/**
 * Hoeveel trainingen elk label en elk thema gebruiken, over álle agendaborden.
 *
 * Gaat door `fetchBoardItems`, dat een onvolledige of incoherente pull weigert. Dat is hier
 * geen luxe: een halve agenda levert lágere tellingen op, en een label dat daardoor op nul
 * uitkomt verdwijnt uit de vondsten — waarna de opruimstap de openstaande melding afvinkt.
 * Een gemiste pagina zou dus een melding wégpoetsen in plaats van er een bij te maken.
 */
export async function readAgendaUsage(client: MondayGraphQLClient): Promise<AgendaUsage> {
  const labels = new Map<string, number>();
  const themas = new Map<string, number>();
  const trainers = new Map<string, number>();

  const bump = (into: Map<string, number>, cell: Cell | undefined): void => {
    for (const id of cell?.linked_item_ids ?? []) {
      const key = String(id);
      into.set(key, (into.get(key) ?? 0) + 1);
    }
  };

  for (const board of reportAgendaBoards()) {
    const count = await checkedSchema(client, board.boardId, agendaUsageExpectedColumns(board));
    const relaties = trainerColumns(board.boardId);
    const ids = [AGENDA_LABEL_COLUMN, board.themaRelation, ...relaties]
      .map((id) => `"${id}"`)
      .join(', ');
    const fields =
      `id updated_at column_values(ids: [${ids}]) ` +
      '{ id text ... on BoardRelationValue { linked_item_ids } }';

    const rows = await client.fetchBoardItems<Row>(board.boardId, fields, count);
    for (const row of rows) {
      const cells = byId(row);
      const label = textOf(cells.get(AGENDA_LABEL_COLUMN));
      labels.set(label, (labels.get(label) ?? 0) + 1);

      bump(themas, cells.get(board.themaRelation));
      for (const relatie of relaties) {
        bump(trainers, cells.get(relatie));
      }
    }
  }

  return { labels, themas, trainers };
}

/** De ids van elk trainer-item dat nu bestaat. Alleen ids: de namen doen hier niet ter zake. */
export async function readTrainers(client: MondayGraphQLClient): Promise<ReadonlySet<string>> {
  const meta: readonly BoardMeta[] = await client.getSchema([TRAINERS_BOARD]);
  const board = meta[0];
  if (board === undefined) {
    throw new Error(`Trainersbord ${TRAINERS_BOARD} niet gevonden of niet toegankelijk.`);
  }
  const rows = await client.fetchBoardItems<Row>(
    TRAINERS_BOARD,
    'id updated_at',
    board.items_count ?? null
  );
  return new Set(rows.map((row) => row.id));
}

/** Elk thema op het Thema's-bord, met de concept-inhoud die de briefing eruit leest. */
export async function readThemas(
  client: MondayGraphQLClient
): Promise<ReadonlyMap<string, ThemaRecord>> {
  const count = await checkedSchema(client, THEMAS_BOARD, THEMA_EXPECTED_COLUMNS);
  const rows = await client.fetchBoardItems<Row>(
    THEMAS_BOARD,
    `id name updated_at column_values(ids: ["${THEMAS_COLUMNS.conceptInhoud}"]) { id text }`,
    count
  );

  const out = new Map<string, ThemaRecord>();
  for (const row of rows) {
    out.set(row.id, {
      naam: (row.name ?? '').trim(),
      conceptInhoud: textOf(byId(row).get(THEMAS_COLUMNS.conceptInhoud)),
    });
  }
  return out;
}

/**
 * De meldingen die al op het Systeem-bord staan.
 *
 * **Keurt het bord vóórdat er één rij wordt gelezen.** Verdwijnt de sleutelkolom, dan komt
 * élke rij terug met een lege sleutel, ziet de run geen enkele bestaande melding, en maakt hij
 * het hele bord nog een keer aan — inclusief een tweede samenvattingsrij. Dat is geen
 * theoretisch geval: de kolom staat zichtbaar op het bord en iemand mag hem weghalen.
 */
export async function readSignals(
  client: MondayGraphQLClient,
  boardId: string
): Promise<readonly ExistingSignal[]> {
  const count = await checkedSchema(client, boardId, SIGNAL_EXPECTED_COLUMNS);
  const rows = await client.fetchBoardItems<Row>(
    boardId,
    `id name updated_at group { id } ` +
      `column_values(ids: ["${SIGNAL_COLUMNS.sleutel}", "${SIGNAL_COLUMNS.afgehandeld}", ` +
      `"${SIGNAL_COLUMNS.detail}", "${SIGNAL_COLUMNS.afgehandeldDoor}"]) ` +
      '{ id text ... on CheckboxValue { checked } }',
    count
  );

  return rows.map((row) => {
    const cells = byId(row);
    return {
      itemId: row.id,
      naam: (row.name ?? '').trim(),
      key: textOf(cells.get(SIGNAL_COLUMNS.sleutel)),
      afgehandeld: isChecked(cells.get(SIGNAL_COLUMNS.afgehandeld)),
      detail: cells.get(SIGNAL_COLUMNS.detail)?.text ?? '',
      groupId: row.group?.id ?? '',
      closedByCheck: textOf(cells.get(SIGNAL_COLUMNS.afgehandeldDoor)) === CLOSED_BY_CHECK,
    };
  });
}

/**
 * De labelconfiguratie zoals de dagelijkse controle hem moet zien: mét de gebreken erin.
 *
 * **Uitdrukkelijk niet `readLabels`.** Die weigert een bord waarop een rij ontbreekt of een
 * verplicht veld leeg is — precies de twee dingen die deze controle hoort te melden. Met de
 * strikte lezer werpt de bron dus juist wanneer er iets te melden valt, vangt `attempt` de
 * fout op, en valt de hele labelcontrole om: `label-ontbreekt` en het grootste deel van
 * `label-onvolledig` worden onbereikbaar, en zelfs de meldingen over onbekende labels
 * verdwijnen. Eén lege cel zou de labelcontrole blind maken.
 *
 * Structurele problemen werpen nog wél — zie `readLabelRows`.
 */
export async function readLabelsForCheck(
  client: Parameters<typeof readLabelRows>[0],
  boardId: string
): Promise<ReadonlyMap<LabelCode, LabelRecord>> {
  const { records } = await readLabelRows(client, boardId);
  return new Map(records.map((r) => [r.code, r]));
}
