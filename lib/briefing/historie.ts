/**
 * De tabel onder het blok `Vaste klant`: eerdere en komende sessies bij dezelfde klant.
 *
 * Alle keuzes hieronder zijn gemeten op 21-Aug-2026 over **beide agendaborden samen, 1780
 * items**, en niet afgeleid uit de specificatie.
 *
 * ## Matchen op `Bedrijf`, niet op de Opportunity
 *
 * `Bedrijf` (`lookup_mkszzfvr`) is een mirror die via de Opportunity doorkijkt naar het
 * Bedrijven-bord. De verleiding is om op de gekoppelde Opportunity te matchen, want dat is
 * een echte relatie in plaats van tekst. Dat is fout: **1030 van de 1037 Opportunity-items
 * hebben `(copy)` in de naam**, want dat bord voert één rij per *deal* en niet per klant.
 * Groeperen op de Opportunity levert 930 groepen op tegen 848 op de mirror — het knipt
 * dezelfde klant in stukken en de trainer ziet de helft van zijn historie.
 *
 * `Bedrijf` is leeg op 52 van de 1780 (2,9%); die trainingen krijgen geen tabel.
 *
 * ## Hoe vaak dit iets oplevert
 *
 * 848 verschillende klanten, waarvan **324 meer dan één sessie** hebben. Grofweg vier op de
 * tien briefings krijgt dus een tabel. De staart is echt: CNV 32 sessies, DAS 28, FNV 17 —
 * vandaar dat `limit` een parameter is en geen vast getal.
 */

import { assertColumns } from '@lib/monday/schema-check';

import { formatContact } from './columns';
import { formatShortDate } from './format';

import type { ExpectedColumn } from '@lib/monday/board-config';
import type { HistoryRow } from './blocks';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * De agendaborden waar de historie uit komt, met per bord de trainerrelatie.
 *
 * **Zes van de zeven kolommen hebben op beide borden hetzelfde id**, gemeten. Alleen de
 * trainerrelatie verschilt, en dat is precies de val die tijdens de evaluatie-analyse 202
 * trainingen trainerloos deed lijken: dezelfde id op het andere bord bestaat gewoon niet,
 * en Monday laat hem dan stilzwijgend weg.
 *
 * Agenda 2025 heeft geen co-trainerkolom; daar is `coTrainerRelation` dus leeg.
 */
export interface HistorieBoard {
  readonly boardId: string;
  readonly trainerRelation: string;
  readonly coTrainerRelation?: string;
}

export const HISTORIE_BOARDS: readonly HistorieBoard[] = [
  {
    boardId: '5087396949',
    trainerRelation: 'board_relation_mkz4y7tb',
    coTrainerRelation: 'itg_cotrainers',
  },
  { boardId: '1703587792', trainerRelation: 'board_relation_mkz4w78' },
];

/** De kolommen die op béíde borden hetzelfde heten. */
const SHARED = {
  bedrijf: 'lookup_mkszzfvr',
  klanttitel: 'tekst_mkmxrqwc',
  datum: 'datum_1',
  tijden: 'dup__of_workshop',
  contactpersoon: 'tekst8',
} as const;

/**
 * Waarden in `Bedrijf` die geen klant zijn.
 *
 * `maatwerk online` staat op 31 trainingen en is een categorie. Zonder deze lijst krijgt
 * elke training die eraan matcht een historie-tabel van 31 losse sessies bij "dezelfde
 * klant", en dat is onzin die er geloofwaardig uitziet.
 *
 * Het staat in code en niet op het Bedrijven-bord omdat dat bord 3466 items telt en niemand
 * dat gaat opschonen voor dit ene geval (Tim, 21-Aug-2026). Groeit de lijst, dan verhuist
 * hij naar het Instellingen-bord.
 */
const NOT_A_CLIENT: readonly string[] = ['maatwerk online'];

/** Hoeveel items per pagina worden opgehaald. */
const PAGE_SIZE = 250;
/** Ruim boven de 943 van het grootste bord; een op hol geslagen cursor mag niet doorlopen. */
const MAX_PAGES = 10;
/**
 * `items(ids:)` **kapt stilzwijgend af op 25**. Bij een klant met dertig sessies zouden de
 * trainers van de laatste rijen zonder foutmelding wegvallen, en de tabel ziet er dan
 * compleet uit met lege namen erin.
 */
const ITEMS_BATCH = 25;

/**
 * Vergelijkbare vorm van een bedrijfsnaam.
 *
 * Een mirror die door meerdere koppelingen kijkt levert soms dezelfde naam dubbel op
 * (`"aaff Audit & Assurance, aaff Audit & Assurance"`). Zeldzaam, maar zonder ontdubbelen
 * valt die klant in twee groepen uiteen.
 */
export function clientKey(bedrijf: string): string {
  const parts = bedrijf
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  const unique = [...new Set(parts)];
  return unique.join(', ');
}

export function isRealClient(bedrijf: string): boolean {
  const key = clientKey(bedrijf);
  return key !== '' && !NOT_A_CLIENT.includes(key);
}

interface RawCell {
  id: string;
  text?: string | null;
  display_value?: string | null;
  date?: string | null;
  linked_item_ids?: readonly (string | number)[] | null;
}

interface RawItem {
  id: string | number;
  column_values: RawCell[];
}

interface Page {
  cursor: string | null;
  items: RawItem[];
}

/**
 * Een cel die is opgevraagd moet ook terugkomen.
 *
 * Monday laat een kolom-id dat het niet kent stilzwijgend weg. Zonder deze controle wordt
 * een verdwenen `Bedrijf` een lege string, matcht er niets, en komt er `[]` uit — wat de
 * aanroeper leest als "gecontroleerd, deze klant heeft geen andere sessies". Het bordschema
 * wordt al vooraf getoetst; dit is de tweede lijn voor het geval een individueel item toch
 * met minder kolommen terugkomt.
 */
function cell(item: RawItem, id: string): RawCell {
  const found = item.column_values.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(
      `Briefing-historie: kolom "${id}" ontbreekt op item ${String(item.id)}. Een ontbrekende ` +
        'kolom is niet hetzelfde als een lege waarde.'
    );
  }
  return found;
}

const cellText = (item: RawItem, id: string): string =>
  (cell(item, id).display_value ?? cell(item, id).text ?? '').trim();

const cellDate = (item: RawItem, id: string): string =>
  (cell(item, id).date ?? cell(item, id).text ?? '').trim();

function linked(item: RawItem, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const found = cell(item, id);
    if (!('linked_item_ids' in found)) {
      throw new Error(
        `Briefing-historie: kolom "${id}" op item ${String(item.id)} is geen board-relatie ` +
          'meer; het kolomtype is gewijzigd.'
      );
    }
    for (const raw of found.linked_item_ids ?? []) {
      const value = String(raw);
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * Wat elk agendabord moet hebben voordat er één rij uit wordt gelezen.
 *
 * Zonder dit is de faalwijze stil en volkomen geloofwaardig: wordt de `Bedrijf`-mirror
 * hernoemd of omgehangen, dan matcht er niets, komt er `[]` uit, en meldt de briefing dat
 * deze klant geen andere sessies heeft. Precies het tegenovergestelde van waar dit blok
 * voor bestaat, bij precies de vaste klanten waar het het meest toe doet.
 *
 * De mirror wordt ook op zijn **bron** getoetst en niet alleen op zijn type: een mirror die
 * door een andere kolom kijkt levert nette namen op van iets anders, en dan matcht de
 * historie op een veld dat de klant niet is.
 */
function expectedColumns(board: HistorieBoard): ExpectedColumn[] {
  return [
    {
      id: SHARED.bedrijf,
      type: 'mirror',
      settingsIncludes: ['"displayed_linked_columns":{"1279052045":["connect_boards31"]}'],
    },
    { id: SHARED.datum, type: 'date' },
    { id: SHARED.klanttitel, type: 'text' },
    { id: SHARED.tijden, type: 'text' },
    { id: SHARED.contactpersoon, type: 'text' },
    ...trainerColumns(board).map((id) => ({
      id,
      type: 'board_relation',
      settingsIncludes: ['"boardIds":[1661151090]'],
    })),
  ];
}

/** Eén sessie, nog met item-ids in plaats van namen. */
interface Session {
  readonly itemId: string;
  readonly datum: string;
  readonly tijden: string;
  readonly klanttitel: string;
  readonly contactpersoon: string;
  readonly trainerIds: readonly string[];
}

function trainerColumns(board: HistorieBoard): string[] {
  return board.coTrainerRelation === undefined
    ? [board.trainerRelation]
    : [board.trainerRelation, board.coTrainerRelation];
}

async function readBoard(
  client: MondayGraphQLClient,
  board: HistorieBoard,
  matches: (bedrijf: string) => boolean
): Promise<Session[]> {
  const [meta] = await client.getSchema([board.boardId]);
  if (meta === undefined) {
    throw new Error(
      `Briefing-historie: agendabord ${board.boardId} is niet gevonden of niet toegankelijk.`
    );
  }
  assertColumns(meta, expectedColumns(board));

  const columns = [...Object.values(SHARED), ...trainerColumns(board)]
    .map((id) => `"${id}"`)
    .join(',');
  const fields =
    `id column_values(ids:[${columns}]) { id text ` +
    '... on MirrorValue { display_value } ' +
    '... on DateValue { date } ' +
    '... on BoardRelationValue { linked_item_ids } }';

  const found: Session[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const document: string =
      cursor === null
        ? `query ($board: [ID!]) { boards(ids: $board) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${fields} } } } }`
        : `query ($cursor: String!) { next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${fields} } } }`;
    const variables: Record<string, unknown> =
      cursor === null ? { board: [board.boardId] } : { cursor };
    const raw: { boards?: Array<{ items_page: Page }>; next_items_page?: Page } =
      await client.query(document, variables);

    const current: Page | undefined =
      cursor === null ? raw.boards?.[0]?.items_page : raw.next_items_page;
    if (current === undefined) {
      throw new Error(
        `Briefing-historie: bord ${board.boardId} gaf geen leesbare pagina terug. ` +
          'Een lege historie melden zou hier "deze klant is nieuw" beweren.'
      );
    }
    for (const item of current.items) {
      if (!matches(cellText(item, SHARED.bedrijf))) {
        continue;
      }
      found.push({
        itemId: String(item.id),
        datum: cellDate(item, SHARED.datum),
        tijden: cellText(item, SHARED.tijden),
        klanttitel: cellText(item, SHARED.klanttitel),
        contactpersoon: cellText(item, SHARED.contactpersoon),
        trainerIds: linked(item, trainerColumns(board)),
      });
    }
    cursor = current.cursor;
    if (cursor === null) {
      return found;
    }
  }
  throw new Error(
    `Briefing-historie: bord ${board.boardId} was na ${MAX_PAGES} pagina's nog niet uitgelezen.`
  );
}

/** Naam plus telefoonnummer per trainer-item, in batches van 25. */
async function readTrainerNames(
  client: MondayGraphQLClient,
  ids: readonly string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let at = 0; at < ids.length; at += ITEMS_BATCH) {
    const batch = ids.slice(at, at + ITEMS_BATCH);
    const data = await client.query<{
      items: Array<{ id: string | number; name: string; column_values: RawCell[] }>;
    }>(
      `query ($ids: [ID!]) {
         items(ids: $ids) { id name column_values(ids: ["telefoon_mkn1hbyh"]) { id text } }
       }`,
      { ids: [...batch] }
    );
    for (const item of data.items ?? []) {
      const phone = (item.column_values[0]?.text ?? '').trim();
      names.set(String(item.id), formatContact(item.name, phone));
    }
  }
  return names;
}

export interface HistorieInput {
  /** De `Bedrijf`-waarde van de training waarvoor de briefing wordt gemaakt. */
  readonly bedrijf: string;
  /** De training zelf hoort niet in haar eigen historie. */
  readonly excludeItemId: string;
  /**
   * Hoeveel rijen er hoogstens in de tabel komen, of `undefined` voor alles.
   *
   * Een parameter en geen constante omdat **nog niet aan Dirkje is gevraagd** hoe lang de
   * tabel mag worden; bij CNV zouden het er 32 zijn. Zodra ze antwoordt is dat één regel
   * bij de aanroeper.
   */
  readonly limit?: number;
}

/**
 * De rijen voor het blok `Vaste klant`, oudste eerst.
 *
 * Een lege array betekent "gezocht, en deze klant heeft verder niets" — dat is een geldig
 * antwoord en het blok verdwijnt dan. Dat is iets anders dan `undefined` doorgeven aan
 * `composeBriefing`, wat "nog niet aangesloten" betekent en een zichtbare `«…»`-regel
 * oplevert.
 */
export async function readHistorie(
  client: MondayGraphQLClient,
  input: HistorieInput
): Promise<HistoryRow[]> {
  if (!isRealClient(input.bedrijf)) {
    return [];
  }
  const wanted = clientKey(input.bedrijf);
  const matches = (bedrijf: string): boolean => clientKey(bedrijf) === wanted;

  const perBoard = await Promise.all(
    HISTORIE_BOARDS.map((board) => readBoard(client, board, matches))
  );
  const sessions = perBoard
    .flat()
    .filter((session) => session.itemId !== input.excludeItemId)
    /**
     * Zonder datum is een rij onbruikbaar: hij is niet te sorteren en de eerste kolom van
     * de tabel blijft leeg. Gemeten is dat zeldzaam (1649 van de 1780 items hebben datum,
     * tijd, klanttitel én een trainer), en weglaten is beter dan een rij met een gat.
     */
    .filter((session) => session.datum !== '')
    .sort((a, b) => a.datum.localeCompare(b.datum));

  /**
   * Afkappen gebeurt aan de **oude** kant, niet aan de nieuwe.
   *
   * De rijen staan oplopend op datum, dus de laatste zijn de recente sessies en de nog
   * komende. Dat is wat een trainer nodig heeft: wie hier onlangs stond en wat er nog
   * aankomt. `slice(0, limit)` zou bij CNV (32 sessies) de acht oudste tonen — april 2025
   * voor iemand die in oktober 2026 voor de groep staat — en er tegelijk volkomen
   * geloofwaardig uitzien.
   */
  const trimmed = input.limit === undefined ? sessions : sessions.slice(-input.limit);
  const namesById = await readTrainerNames(
    client,
    [...new Set(trimmed.flatMap((session) => session.trainerIds))]
  );

  return trimmed.map((session) => ({
    datum: formatShortDate(session.datum),
    /**
     * `Tijden` gaat er **letterlijk** in, zonder normaliseren. Tim, 24-Aug-2026: *"why not
     * just copy exactly what is in the tijden? they can always edit it."*
     *
     * Er is ook geen ijkpunt om naar toe te normaliseren: ITG's bronbestand zegt over deze
     * tabel alleen `*** INVOEGEN *** Tabel met onderstaande kolommen`, en de kolom is vrije
     * tekst met 299 verschillende waarden — `13:00 tot 17:00`, `n.o.t.k.` en meerdere
     * dagdelen met een `&` ertussen. Wat wij er dan van maken is een gok; wat er staat is
     * in elk geval wat de planner heeft ingevuld, en de adviseur past het in Word aan.
     */
    tijd: session.tijden,
    klanttitel: session.klanttitel,
    /**
     * Meerdere trainers komen achter elkaar in één cel. De tabel heeft één trainerkolom,
     * en een tweede rij voor dezelfde sessie zou als een tweede sessie lezen.
     */
    trainer: session.trainerIds
      .map((id) => namesById.get(id) ?? '')
      .filter((naam) => naam !== '')
      .join(', '),
    contactpersoon: session.contactpersoon,
  }));
}
