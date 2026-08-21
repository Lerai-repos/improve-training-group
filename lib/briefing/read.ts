/**
 * Eén training van het agendabord lezen, met alles wat de briefing nodig heeft.
 *
 * Vier stappen, omdat de gegevens over vier borden verspreid staan:
 *
 * 1. het agenda-item zelf, met de thema- en trainerrelatie
 * 2. de trainers (naam + telefoon) van het trainersbord
 * 3. de accountmanager z'n mobiele nummer via `users` — dat staat niet op het bord
 * 4. de contactpersoon via Opportunity → Contacten, want de naam op de agenda heeft
 *    **nooit** een telefoonnummer: gemeten, 0 van 815
 *
 * De mirrors `spiegel6` en `spiegel8` op de agenda heten wél Contactpersoon maar zijn
 * leeg — 0 van 815 — dus die omweg is niet optioneel.
 */

import { assertNoDuplicateIds } from '@lib/monday/completeness';
import { assertColumns } from '@lib/monday/schema-check';

import { agendaBoardId } from '@lib/monday/board-config';

import {
  BRIEFING_AGENDA_COLUMNS,
  CONTACT_COLUMNS,
  OPPORTUNITY_COLUMNS,
  TRAINER_ACTEURS_GROUP,
} from './columns';

import type { ExpectedColumn } from '@lib/monday/board-config';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { BriefingTraining, BriefingTrainer, MissingField } from './types';

const C = BRIEFING_AGENDA_COLUMNS;

/** Het Opportunitybord waar de agenda naartoe koppelt. */
const OPPORTUNITY_BOARD = '1279052045';

/** Telefoonnummer op het trainersbord. Zelfde kolom die de aanbevelingen voor WhatsApp lezen. */
const TRAINER_PHONE_COLUMN = 'telefoon_mkn1hbyh';

/**
 * De relatiekolommen mét het bord waar ze naartoe horen te wijzen.
 *
 * Een relatie die relatie blíjft maar naar een ander bord wordt omgehangen levert nog
 * steeds een keurige array met item-ids op. `linkedIds()` ziet daar niets van, en de
 * briefing zou dan vrolijk namen van een willekeurig ander bord invullen. `settings_str`
 * is het enige dat dat verraadt.
 */
export const BRIEFING_EXPECTED_COLUMNS: ExpectedColumn[] = [
  { id: C.themaRelation, type: 'board_relation', settingsIncludes: ['"boardIds":[5067928440]'] },
  { id: C.trainerRelation, type: 'board_relation', settingsIncludes: ['"boardIds":[1661151090]'] },
  { id: C.opportunity, type: 'board_relation', settingsIncludes: ['"boardIds":[1279052045]'] },
  { id: C.datum, type: 'date' },
  /**
   * De mirror moet niet alleen een mirror zijn, hij moet ook nog uit dezelfde bron komen.
   * `displayed_linked_columns` noemt het Opportunitybord en de kolom waar hij doorheen
   * kijkt; wordt die opnieuw gekoppeld, dan staat er straks een andere klantnaam in élke
   * briefing en is er niets dat dat verraadt.
   */
  {
    id: C.opdrachtgever,
    type: 'mirror',
    settingsIncludes: ['"displayed_linked_columns":{"1279052045":["connect_boards31"]}'],
  },
  { id: C.accountmanager, type: 'people' },
];

/** Zonder deze velden is de briefing zichtbaar kapot, niet alleen karig. */
const REQUIRED: ReadonlyArray<{ column: string; label: string; of: keyof BriefingTraining }> = [
  { column: C.datum, label: 'Datum', of: 'datum' },
  { column: C.duurTekst, label: 'Duur', of: 'duur' },
  { column: C.locatie, label: 'Locatie', of: 'locatie' },
  { column: C.opdrachtgever, label: 'Opdrachtgever', of: 'opdrachtgever' },
  /**
   * Het label kiest het sjabloon. Zonder label is er niets om te genereren, dus dit is
   * geen schoonheidsfoutje maar een harde voorwaarde.
   */
  { column: C.label, label: 'Label', of: 'label' },
  /** Zonder Tijden geen datum-en-tijdregel én geen materialen-deadline. */
  { column: C.tijden, label: 'Tijden', of: 'tijden' },
  /** Zonder Taal staat er een lege Voertaal-rij in het document. */
  { column: C.taal, label: 'Voertaal', of: 'voertaal' },
];

/** De negen labels waarvoor een sjabloon bestaat. Een ander label kan niet gegenereerd worden. */
export const SUPPORTED_LABELS: readonly string[] = [
  'CC', 'CP', 'FT', 'FV', 'IT', 'JE', 'SST', 'TT', 'WJ',
];

interface RawColumn {
  id: string;
  text?: string | null;
  /** Mirrors leveren hun waarde HIER, niet in `text` — zie `text()` hieronder. */
  display_value?: string | null;
  /**
   * `DateValue.date`, altijd `YYYY-MM-DD`.
   *
   * `text` van een datumkolom volgt het datumformaat in het profiel van de API-gebruiker.
   * Staat dat op DD-MM-YYYY, dan is `Datum` wél gevuld — dus de volledigheidscontrole komt
   * er doorheen — maar herkent `materialsDeadline()` hem niet en verdwijnt de
   * materialen-deadline stilzwijgend uit de briefing.
   */
  date?: string | null;
  /** Leeg is zowel `[]` als `null`; zie `linkedIds()`. */
  linked_item_ids?: Array<string | number> | null;
  persons_and_teams?: Array<{ id: string | number; kind: string }>;
}

interface RawItem {
  id: string | number;
  name: string;
  board?: { id: string | number } | null;
  /** Alleen opgevraagd bij trainers: bepaalt of iemand in de groep `Acteurs` zit. */
  group?: { id: string } | null;
  column_values?: RawColumn[];
}

const AGENDA_IDS = Object.values(C);

const ITEM_FIELDS = `
  id
  name
  board { id }
  column_values(ids: ${JSON.stringify(AGENDA_IDS)}) {
    id
    text
    ... on BoardRelationValue { linked_item_ids }
    ... on PeopleValue { persons_and_teams { id kind } }
    ... on MirrorValue { display_value }
    ... on DateValue { date }
  }
`;

/**
 * De cel opzoeken, en weigeren als Monday hem niet teruggaf.
 *
 * Dit is de hele reden dat deze functie bestaat. Monday laat een kolom-id dat het niet
 * herkent stilletjes weg, dus een hernoemde of verwijderde kolom komt terug als een lege
 * waarde. Zou dat doorgaan als "leeg", dan zetten we `Brie` op "Begonnen, niet klaar" met
 * de mededeling dat de adviseur iets vergeten is, terwijl wíj de kolom kwijt zijn.
 */
function cell(item: RawItem, id: string): RawColumn {
  const found = (item.column_values ?? []).find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(
      `Briefing: kolom "${id}" ontbreekt op training ${item.id}. Een ontbrekende kolom is ` +
        'niet hetzelfde als een lege waarde; controleer of de kolom hernoemd of verwijderd is.'
    );
  }
  return found;
}

/**
 * De waarde van een cel als tekst.
 *
 * **Een mirror geeft `text: null` en zet de waarde in `display_value`.** Gemeten op het
 * agendabord: `Bedrijf` (`lookup_mkszzfvr`) levert 0 van 816 via `text` en 816 van 816 via
 * `display_value`. Alleen `text` lezen zou dus bij élke briefing melden dat de
 * opdrachtgever ontbreekt — een lege rij die eruitziet als een fout van de adviseur.
 */
/**
 * De gekoppelde item-ids van een relatiekolom.
 *
 * `cell()` bewijst alleen dat de kolom-id bestáát. Wordt een board_relation omgezet naar
 * een ander type, dan laat GraphQL `linked_item_ids` weg en komt de kolom terug zónder dat
 * veld — en `?? []` zou dat lezen als "geen thema gekoppeld". Dat is precies dezelfde
 * verwarring tussen drift en leegte die `cell()` elders voorkomt, één laag dieper.
 *
 * Een lege array is prima; een ontbrekend veld niet.
 */
function linkedIds(item: RawItem, id: string): string[] {
  const value = cell(item, id);
  if (!('linked_item_ids' in value)) {
    throw new Error(
      `Briefing: kolom "${id}" op training ${item.id} levert geen board-relatie terug. ` +
        'Waarschijnlijk is het kolomtype gewijzigd; een gewijzigd type is niet hetzelfde ' +
        'als een lege koppeling.'
    );
  }
  const linked = value.linked_item_ids;
  /**
   * `null` is een geldige lege relatie, geen drift.
   *
   * Monday geeft voor een leeg relatieveld zowel `[]` als `null` terug — `decode.ts` in
   * deze repo gaat daar al van uit (`string[] | null`). Alleen op `Array.isArray` toetsen
   * zou een training zonder trainer laten crashen in plaats van hem netjes als
   * onvolledig te melden.
   */
  if (linked === null || linked === undefined) {
    return [];
  }
  if (!Array.isArray(linked)) {
    throw new Error(
      `Briefing: kolom "${id}" op training ${item.id} levert een onverwacht type voor ` +
        'linked_item_ids; het kolomtype is waarschijnlijk gewijzigd.'
    );
  }
  return linked.map(String);
}

const text = (item: RawItem, id: string): string => {
  const value = cell(item, id);
  return (value.display_value ?? value.text ?? '').trim();
};

/** Namen van gekoppelde items, in de volgorde waarin ze gekoppeld zijn. */
async function readLinkedNames(
  client: MondayGraphQLClient,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const data = await client.query<{ items: Array<{ id: string | number; name: string }> }>(
    'query ($ids: [ID!]) { items(ids: $ids) { id name } }',
    { ids: [...ids] }
  );
  const found = new Map((data.items ?? []).map((i) => [String(i.id), i.name]));
  assertAllResolved(ids, found.keys(), "thema's");
  return found;
}

/**
 * Elk gevraagd item moet ook terugkomen.
 *
 * Een verwijderd of onbereikbaar gekoppeld item laat Monday gewoon weg uit het antwoord.
 * Bij twee trainers levert dat er stilletjes één op: `trainers.length` is niet nul, de
 * volledigheidscontrole komt er doorheen, en de co-trainer verdwijnt uit de briefing
 * zonder dat iemand het ziet. Bij een thema komt het onopgeloste item-id als naam in het
 * document terecht.
 */
function assertAllResolved(
  requested: readonly string[],
  returned: Iterable<string>,
  wat: string
): void {
  const have = new Set(returned);
  const lost = requested.filter((id) => !have.has(id));
  if (lost.length > 0) {
    throw new Error(
      `Briefing: ${lost.length} van de ${requested.length} gekoppelde ${wat} konden niet ` +
        `worden opgehaald (${lost.join(', ')}). Mogelijk verwijderd of niet toegankelijk.`
    );
  }
}

/** Trainers met hun telefoonnummer; de briefing zet dat in de lead- en co-blokken. */
async function readTrainers(
  client: MondayGraphQLClient,
  ids: readonly string[]
): Promise<BriefingTrainer[]> {
  if (ids.length === 0) {
    return [];
  }
  const data = await client.query<{ items: RawItem[] }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         name
         group { id }
         column_values(ids: ["${TRAINER_PHONE_COLUMN}"]) { id text }
       }
     }`,
    { ids: [...ids] }
  );
  const items = data.items ?? [];
  assertNoDuplicateIds(items.map((i) => String(i.id)), 'Briefing: trainers');
  assertAllResolved(ids, items.map((i) => String(i.id)), 'trainers');

  /**
   * De **koppelvolgorde** bepaalt wie lead is en wie co-trainer.
   *
   * `items(ids:)` mag zijn antwoord in elke volgorde teruggeven — bordvolgorde bijvoorbeeld
   * — en dat is niet de volgorde waarin ze gekoppeld zijn. Het antwoord blind overnemen
   * kan lead en co omdraaien, en dan krijgt de co-trainer het blok met "jij bent
   * verantwoordelijk voor het klantcontact".
   */
  const byId = new Map(items.map((i) => [String(i.id), i]));
  return ids.map((id) => {
    const found = byId.get(id) as RawItem;
    return {
      itemId: id,
      naam: found.name,
      telefoon: (cell(found, TRAINER_PHONE_COLUMN).text ?? '').trim(),
      isActeur: found.group?.id === TRAINER_ACTEURS_GROUP,
    };
  });
}

/**
 * Het mobiele nummer van de accountmanager.
 *
 * Staat niet op het agendabord: de people-kolom levert alleen een gebruikers-id. Dirkje's
 * opmerking in de voorbeeldbriefing zegt het ook, "Mobiel tel nr van de AM in Monday
 * systeem". Gemeten: alle zeven AM's hebben er een.
 */
async function readAccountmanager(
  client: MondayGraphQLClient,
  userId: string | null
): Promise<{ naam: string; mobiel: string } | null> {
  if (userId === null) {
    return null;
  }
  const data = await client.query<{
    users: Array<{ id: string | number; name: string; mobile_phone: string | null }>;
  }>('query ($ids: [ID!]) { users(ids: $ids) { id name mobile_phone } }', { ids: [userId] });
  const user = (data.users ?? [])[0];
  return user === undefined
    ? null
    : { naam: user.name, mobiel: (user.mobile_phone ?? '').trim() };
}

/**
 * De contactpersoon met telefoonnummer, via Opportunity → Contacten.
 *
 * Twee sprongen, en het nummer is er maar in ongeveer de helft van de gevallen — 147 van
 * 300 gemeten. Geen nummer is dus de normale gang van zaken, geen fout, en de opmaaklaag
 * valt terug op alleen de naam.
 */
/**
 * Het Opportunitybord, met de relatie naar Contacten vastgepind.
 *
 * De tweede sprong verdient dezelfde controle als de eerste: blijft `deal_contact` een
 * board_relation maar wijst hij naar een ander bord, dan levert hij nog steeds keurige
 * item-ids op en zetten we het telefoonnummer van een wildvreemde in de briefing.
 */
const OPPORTUNITY_EXPECTED_COLUMNS: ExpectedColumn[] = [
  {
    id: OPPORTUNITY_COLUMNS.contact,
    type: 'board_relation',
    settingsIncludes: ['"boardIds":[1279052020]'],
  },
];

async function readContact(
  client: MondayGraphQLClient,
  opportunityItemId: string | null,
  agendaNaam: string
): Promise<{ naam: string; telefoon: string } | null> {
  const naam = agendaNaam.trim();
  if (opportunityItemId === null) {
    return naam === '' ? null : { naam, telefoon: '' };
  }
  const [oppMeta] = await client.getSchema([OPPORTUNITY_BOARD]);
  if (oppMeta === undefined) {
    throw new Error(`Briefing: Opportunitybord ${OPPORTUNITY_BOARD} niet toegankelijk`);
  }
  assertColumns(oppMeta, OPPORTUNITY_EXPECTED_COLUMNS);

  const opp = await client.query<{ items: RawItem[] }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id name
         column_values(ids: ["${OPPORTUNITY_COLUMNS.contact}"]) {
           id ... on BoardRelationValue { linked_item_ids }
         }
       }
     }`,
    { ids: [opportunityItemId] }
  );
  const oppItem = (opp.items ?? [])[0];
  /**
   * Een gevulde relatie die niets oplevert is drift, geen leegte.
   *
   * Terugvallen op de agendanaam zou een verouderde of onbereikbare koppeling laten
   * doorgaan voor "deze klant heeft nu eenmaal geen contactpersoon" — en dan mist het
   * telefoonnummer zonder dat iemand weet waarom.
   */
  assertAllResolved([opportunityItemId], oppItem === undefined ? [] : [String(oppItem.id)], 'Opportunity');
  const linked = linkedIds(oppItem, OPPORTUNITY_COLUMNS.contact);
  if (linked.length === 0) {
    return naam === '' ? null : { naam, telefoon: '' };
  }

  const contact = await client.query<{ items: RawItem[] }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) { id name column_values(ids: ["${CONTACT_COLUMNS.telefoon}"]) { id text } }
     }`,
    { ids: linked }
  );
  const contactItems = contact.items ?? [];
  /**
   * Alle gekoppelde contactpersonen moeten terugkomen vóórdat we kiezen.
   *
   * Zijn er twee gekoppeld en is er één verwijderd, dan blijft er precies één over — en
   * dan zou de "één kandidaat, dus dat zal 'm zijn"-regel hieronder een gok doen bij een
   * relatie die in werkelijkheid dubbelzinnig was.
   */
  assertAllResolved(linked, contactItems.map((c) => String(c.id)), 'contactpersonen');
  const candidates = contactItems.map((c) => ({
    naam: c.name.trim(),
    telefoon: (cell(c, CONTACT_COLUMNS.telefoon).text ?? '').trim(),
  }));

  /**
   * De agenda bepaalt WIE het is; het contactenbord levert alleen het nummer.
   *
   * Een Opportunity kan meerdere contactpersonen hebben, en de eerste koppeling is niet
   * per se degene die bij déze training hoort. Blind de eerste pakken zet de verkeerde
   * naam én het verkeerde 06-nummer in een briefing die naar een trainer gaat, en dat
   * ziet er volkomen normaal uit.
   *
   * Staat er geen naam op de agenda (125 van de 816), dan is de enige gekoppelde
   * contactpersoon een redelijke gok — maar bij meerdere kandidaten raden we niet.
   */
  if (naam !== '') {
    const match = candidates.find((c) => c.naam.toLowerCase() === naam.toLowerCase());
    return { naam, telefoon: match?.telefoon ?? '' };
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export async function readBriefingTraining(
  client: MondayGraphQLClient,
  itemId: string,
  options: { boardId?: string } = {}
): Promise<BriefingTraining> {
  /**
   * Eerst het bord controleren, dan pas de gegevens vertrouwen.
   *
   * Dit vangt wat geen enkele item-query kan zien: een relatie die naar een ander bord is
   * omgehangen, of een kolom die van type is veranderd. Eén extra call per run, en de
   * aanbevelingsengine doet hetzelfde met `assertColumns`.
   */
  const boardId = options.boardId ?? agendaBoardId();
  const [meta] = await client.getSchema([boardId]);
  if (meta === undefined) {
    throw new Error(`Briefing: agendabord ${boardId} niet gevonden of niet toegankelijk`);
  }
  assertColumns(meta, BRIEFING_EXPECTED_COLUMNS);

  const data = await client.query<{ items: RawItem[] }>(
    `query ($ids: [ID!]) { items(ids: $ids) { ${ITEM_FIELDS} } }`,
    { ids: [itemId] }
  );
  const item = (data.items ?? [])[0];
  if (item === undefined) {
    throw new Error(`Briefing: training ${itemId} niet gevonden of niet toegankelijk`);
  }
  /**
   * `items(ids:)` zoekt door het hele account, niet binnen één bord.
   *
   * Er bestaat een kopie van het agendabord (voor ons eigen werk), dus een item-id van
   * dáár zou hier gelezen worden terwijl we het schema van het ingestelde bord hebben
   * gecontroleerd. Dan klopt de controle wel, maar niet voor dit item.
   */
  const itemBoard = item.board?.id === undefined ? null : String(item.board.id);
  if (itemBoard !== boardId) {
    throw new Error(
      `Briefing: training ${itemId} staat op bord ${itemBoard ?? 'onbekend'}, niet op het ` +
        `ingestelde agendabord ${boardId}.`
    );
  }

  const themaIds = linkedIds(item, C.themaRelation);
  const trainerIds = linkedIds(item, C.trainerRelation);
  const oppIds = linkedIds(item, C.opportunity);
  const opportunityItemId = oppIds[0] ?? null;
  const people = cell(item, C.accountmanager).persons_and_teams ?? [];
  const amId = people.length > 0 ? String(people[0].id) : null;

  const [themaNames, trainers, accountmanager, contactpersoon] = await Promise.all([
    readLinkedNames(client, themaIds),
    readTrainers(client, trainerIds),
    readAccountmanager(client, amId),
    readContact(client, opportunityItemId, text(item, C.contactpersoonNaam)),
  ]);

  const acteurRaw = text(item, C.acteuraantal);
  const training: BriefingTraining = {
    itemId: String(item.id),
    naam: item.name,
    label: text(item, C.label),
    brie: text(item, C.brie),
    opdrachtgever: text(item, C.opdrachtgever),
    themas: themaIds.map((id) => themaNames.get(id) ?? id),
    klanttitel: text(item, C.klanttitel),
    duur: text(item, C.duurTekst),
    datum: (cell(item, C.datum).date ?? '').trim() || text(item, C.datum),
    tijden: text(item, C.tijden),
    groepsgrootte: text(item, C.deelnemers),
    locatie: text(item, C.locatie),
    voertaal: text(item, C.taal),
    klantcontactmoment: text(item, C.klantcontactmoment),
    evaluatie: text(item, C.qr),
    ieCode: text(item, C.ieCode),
    accountmanager,
    contactpersoon: contactpersoon?.naam.trim() ? contactpersoon : null,
    trainers,
    acteuraantal: acteurRaw === '' ? null : Number(acteurRaw),
    opportunityItemId,
    missing: [],
  };

  const missing: MissingField[] = REQUIRED.filter(
    (r) => String(training[r.of] ?? '').trim() === ''
  ).map((r) => ({ column: r.column, label: r.label }));

  // Een thema is geen tekstveld maar zonder thema heeft de briefing geen onderwerp.
  if (training.themas.length === 0) {
    missing.push({ column: C.themaRelation, label: "Thema's" });
  }
  if (accountmanager === null) {
    missing.push({ column: C.accountmanager, label: 'Accountmanager' });
  }
  /**
   * Zonder trainer is er geen ontvanger: het bestand heet naar de trainer, en de lead- en
   * co-trainerblokken zijn niet te bouwen. "Klaar om te genereren" melden zou dan een
   * document beloven dat nergens heen kan.
   *
   * **Een acteur telt hier niet mee.** De relatie mengt trainers en acteurs, dus een training
   * waar alleen een acteur aan hangt heeft wél een gevulde relatie en tóch geen ontvanger.
   * Op `trainers.length` kijken zou die als compleet afvinken.
   */
  if (trainers.every((t) => t.isActeur)) {
    missing.push({ column: C.trainerRelation, label: 'Trainer' });
  }
  /**
   * Een label dat we niet kennen is erger dan een leeg label: `TMT`, `YNS`,
   * `ST - StressTrainer` en `Email` staan wél op het bord (16 trainingen) maar hebben geen
   * sjabloon. Zonder deze controle zou het genereren pas verderop struikelen, op een
   * ontbrekend bestand.
   */
  if (training.label !== '' && !SUPPORTED_LABELS.includes(training.label)) {
    missing.push({ column: C.label, label: `Label "${training.label}" heeft geen sjabloon` });
  }

  return { ...training, missing };
}
