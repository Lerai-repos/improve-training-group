import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { sampleCleanupPlan, unresolvedCreateVerdict, type SampleState } from './provisioning';

/**
 * De IO-schil om `provisioning.ts` heen: intentiebestand, voorbeeldinhoud, bordinhoud lezen.
 *
 * De BESLISSINGEN staan hiernaast in `provisioning.ts` en zijn puur. Hier staat alleen wat
 * onvermijdelijk aan een bestandssysteem en een Monday-client vastzit, zodat twee
 * inrichtingsscripts dezelfde — en dus even goed doordachte — schil delen in plaats van er
 * ieder een eigen kopie van te laten wegdrijven.
 */

/** Wat elk inrichtingsscript over zijn eigen halve werk moet onthouden. */
export interface ProvisionIntent {
  runId: string;
  /** Wanneer deze poging begon; bepaalt of Monday's idempotency-sleutel nog iets betekent. */
  startedAt: number;
  boardId?: string;
  samples: SampleState;
}

/** Deterministisch per operatie, zodat een herhaling de sleutel hergebruikt. */
export const keyFor = (intent: ProvisionIntent, op: string): string => `${intent.runId}:${op}`;

export interface IntentFile {
  read(): ProvisionIntent | null;
  write(intent: ProvisionIntent): void;
}

/** Een `SampleState` uit het bestand, of `uncaptured` als hij er niet (goed) in staat. */
function readSampleState(value: unknown): SampleState {
  if (typeof value !== 'object' || value === null) {
    return { phase: 'uncaptured' };
  }
  const record: Record<string, unknown> = { ...value };
  if (record.phase === 'cleared') {
    return { phase: 'cleared' };
  }
  if (record.phase === 'captured') {
    const { itemIds, groupIds } = record;
    if (Array.isArray(itemIds) && Array.isArray(groupIds)) {
      return { phase: 'captured', itemIds: itemIds.map(String), groupIds: groupIds.map(String) };
    }
  }
  return { phase: 'uncaptured' };
}

/**
 * Het intentiebestand, met één regel die het bestaansrecht ervan is: schrijf VÓÓR de mutatie.
 *
 * Wachten tot `create_board` antwoordt dekt het geval niet dat echt bijt — Monday maakt het
 * bord en het antwoord gaat verloren. Bij een nieuwe start ontstaat dan een andere `runId`,
 * dus een andere sleutel, dus een TWEEDE bord.
 */
export function intentFile(path: string): IntentFile {
  return {
    /**
     * Leest het bestand, en vult aan wat een OUDERE versie nog niet opschreef.
     *
     * Het eerste formaat had alleen `runId` en `boardId`. Zo'n bestand ongezien als
     * `ProvisionIntent` behandelen laat `samples` op `undefined` staan, en dan struikelt
     * `sampleCleanupPlan` over `samples.phase` — een crash bij precies de herstelrun waar dit
     * bestand voor bestaat. Veld voor veld lezen in plaats van casten, om dezelfde reden.
     *
     * `startedAt` valt terug op `0`: dat is ouder dan elk idempotentievenster, dus een
     * onbeslist `create_board` wordt geweigerd in plaats van opnieuw verstuurd. De veilige
     * kant, want bij een oud bestand weten we niet meer wanneer die aanroep is gedaan.
     */
    read(): ProvisionIntent | null {
      if (!existsSync(path)) {
        return null;
      }
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`${path} is geen object; verwijder het bestand en begin opnieuw.`);
      }
      const record: Record<string, unknown> = { ...raw };
      const { runId, boardId, startedAt } = record;
      if (typeof runId !== 'string' || runId === '') {
        throw new Error(`${path} mist runId; verwijder het bestand en begin opnieuw.`);
      }
      return {
        runId,
        boardId: typeof boardId === 'string' && boardId !== '' ? boardId : undefined,
        startedAt: typeof startedAt === 'number' ? startedAt : 0,
        samples: readSampleState(record.samples),
      };
    },
    write(intent: ProvisionIntent): void {
      writeFileSync(path, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    },
  };
}

export interface BoardContent {
  columns: Array<{ id: string }>;
  groups: Array<{ id: string; title: string }>;
  items: Array<{ id: string; name: string }>;
}

/**
 * De lezers zijn per vraag CONCREET getypeerd, niet `query<T>(): Promise<T>`.
 *
 * Die generieke vorm belooft "ik geef terug wat je vraagt", en dat kan geen enkele echte
 * implementatie waarmaken zonder een cast — de echte client parst JSON en weet niets. Het
 * gevolg is dat élke testdubbel diezelfde cast moet overnemen, precies op de plek waar je
 * juist wilt kunnen zien dat de vorm klopt. Met een concreet antwoordtype past de echte
 * client nog steeds (T wordt afgeleid) en heeft een testdubbel geen cast meer nodig.
 */
interface BoardContentReader {
  query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{
    boards?: Array<{
      columns?: Array<{ id: string }> | null;
      groups?: Array<{ id: string; title: string }> | null;
      items_page?: { items?: Array<{ id: string; name: string }> | null } | null;
    }> | null;
  }>;
}

interface BoardIdentityReader {
  query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{
    boards?: Array<{
      id: string;
      name: string;
      description?: string | null;
      workspace_id?: string | number | null;
    }> | null;
  }>;
}

/** `cleanupSamples` gebruikt het antwoord niet; `unknown` is hier de eerlijke vorm. */
interface Writer {
  mutate(
    query: string,
    variables?: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<unknown>;
}

export async function readBoardContent(
  read: BoardContentReader,
  boardId: string
): Promise<BoardContent | null> {
  const d = await read.query(
    'query ($b: [ID!]) { boards(ids: $b) { columns { id } groups { id title } ' +
      'items_page(limit: 50) { items { id name } } } }',
    { b: [boardId] }
  );
  const board = d.boards?.[0];
  if (board === undefined) {
    return null;
  }
  return {
    columns: board.columns ?? [],
    groups: board.groups ?? [],
    items: board.items_page?.items ?? [],
  };
}

export interface BoardIdentity {
  readonly name: string;
  readonly workspaceId: string;
  /**
   * Zie `provisionFingerprint`. Moet letterlijk in de bordomschrijving staan.
   *
   * OPTIONEEL, want borden van vóór dit merkteken bestaan: het Briefings-bord is in
   * augustus aangemaakt en draagt er geen. Voor die borden blijft de naam-en-werkruimte
   * controle over, plus de inhoudscontrole in `cleanupSamples` — die laatste beschermt
   * tegen de schade zelf en heeft geen merkteken nodig.
   */
  readonly fingerprint?: string;
}

/**
 * Het merkteken dat een bord aan één run van één script bindt.
 *
 * **Waarom naam + werkruimte niet genoeg is.** Monday staat twee borden met dezelfde naam in
 * dezelfde werkruimte toe. Een oud of afgebroken bord "Labels" komt dus door een controle op
 * naam en werkruimte heen, en heeft het onze kolommen niet, dan legt `captureSamples` zijn
 * eerste vijftig items vast als voorbeeldinhoud en verwijdert ze. Vandaag staan er dertien
 * borden in de werkruimte zonder één dubbele naam — maar dat is een waarneming van vandaag,
 * geen eigenschap van Monday.
 *
 * Het loopt door de bordOMSCHRIJVING, niet door de naam: de naam is wat mensen lezen en
 * hernoemen, de omschrijving raakt niemand aan. Hij bevat de `runId`, zodat hij niet alleen
 * "door dit script gemaakt" zegt maar "door DEZE poging" — precies het onderscheid tussen het
 * bord dat we kwijt zijn en een eerdere afgebroken poging.
 */
export function provisionFingerprint(slug: string, runId: string): string {
  return `itg-provision:${slug}:${runId}`;
}

/**
 * Bewijs dat dit het bord is dat we denken dat het is, vóórdat er iets verdwijnt.
 *
 * **Het gat dat dit dichtzet.** Gaat het antwoord op `create_board` verloren, dan vraagt het
 * script een mens om `boardId` met de hand in het intentiebestand te zetten. Zet die er een id
 * in van een ánder bord — een typefout, het verkeerde tabblad — dan staan onze kolommen daar
 * niet, concludeert `sampleCleanupPlan` dat er nog niets van ons is, en legt `captureSamples`
 * de eerste 50 items van dat bord vast als "Monday's voorbeeldinhoud". Die worden vervolgens
 * verwijderd. Het herstelpad voor een verloren antwoord was daarmee het gevaarlijkste pad in
 * het script.
 *
 * Naam én werkruimte, want geen van beide is alleen genoeg: twee werkruimtes kunnen allebei
 * een bord "Labels" hebben, en binnen één werkruimte zegt het werkruimte-id niets.
 */
export async function assertBoardIdentity(
  read: BoardIdentityReader,
  boardId: string,
  expected: BoardIdentity
): Promise<void> {
  const data = await read.query(
    'query ($b: [ID!]) { boards(ids: $b) { id name description workspace_id } }',
    { b: [boardId] }
  );

  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(
      `Bord ${boardId} bestaat niet (of is niet zichtbaar voor dit token). Controleer het id ` +
        'in het intentiebestand.'
    );
  }

  // Monday geeft het werkruimte-id als GETAL terug; elders in dit project is precies dat het
  // verschil tussen "klopt" en "klopt niet".
  const workspaceId =
    board.workspace_id === null || board.workspace_id === undefined
      ? ''
      : String(board.workspace_id);

  if (board.name.trim() !== expected.name || workspaceId !== expected.workspaceId) {
    throw new Error(
      `Bord ${boardId} is "${board.name}" in werkruimte ${workspaceId || '(onbekend)'}, ` +
        `verwacht "${expected.name}" in ${expected.workspaceId}.\n` +
        'Er wordt niets aangeraakt: op een verkeerd bord zou het opruimen van ' +
        "Monday's voorbeeldinhoud echte rijen verwijderen."
    );
  }

  /**
   * En dan pas het merkteken, want een naam bewijst niets over herkomst.
   *
   * Ontbreekt het, dan is dit een bord dat wij niet hebben aangemaakt — of een eerdere
   * poging. In beide gevallen is opruimen het verkeerde antwoord, en in het eerste geval is
   * het gegevensverlies.
   */
  if (
    expected.fingerprint !== undefined &&
    !(board.description ?? '').includes(expected.fingerprint)
  ) {
    throw new Error(
      `Bord ${boardId} heet "${board.name}" en staat in de goede werkruimte, maar de ` +
        `omschrijving bevat "${expected.fingerprint}" niet.\n` +
        'Monday staat twee borden met dezelfde naam toe, dus naam en werkruimte bewijzen ' +
        'niet dat dit hét bord is — en op een vreemd bord zou het opruimen van ' +
        "Monday's voorbeeldinhoud echte rijen verwijderen.\n" +
        'Wat wel klopt staat in de omschrijving van het bord in Monday: zoek daar de regel ' +
        '"itg-provision:...", en zet de "runId" uit dat merkteken in het intentiebestand.'
    );
  }
}

/** Monday's eigen voorbeeldgroep. Twee titels, want hij is niet consistent. */
const SAMPLE_GROUP_TITLES = new Set(['Group Title', 'Group 1']);

/**
 * Hoe een bord eruitziet, in één regel — puur om een mens te laten oordelen.
 *
 * NIET om zelf een besluit op te baseren. Een eerdere versie liet verwijderen toe zodra een
 * bord "er vers uitzag" (weinig items, standaard groepsnamen), en dat is geen bewijs van
 * eigendom: Monday staat twee borden met dezelfde naam toe, en een écht ander Briefings-bord
 * met vijf rijen en een groep "Group Title" komt door zo'n vormtoets heen. Daarna verwijdert
 * het opruimpad die vijf echte rijen. Vorm is een aanwijzing, geen toestemming.
 */
export function describeBoardShape(board: BoardContent): string {
  const groepen = board.groups.map((g) => `"${g.title}"`).join(', ') || 'geen';
  return `${board.items.length} item(s), groepen: ${groepen}`;
}

/**
 * Leg vast wat van Monday is, zolang dat nog met zekerheid vast te stellen is.
 *
 * Draait direct na `create_board` en vóór de eerste eigen kolom — het enige moment waarop
 * "alles op dit bord" en "Monday's voorbeeldinhoud" hetzelfde zijn. De ids gaan naar het
 * intentiebestand vóórdat er iets verdwijnt, zodat een hervatting tegen die vastgelegde
 * verzameling werkt in plaats van hem af te leiden uit een bord dat dan echte rijen bevat.
 */
export async function captureSamples(
  read: BoardContentReader,
  boardId: string,
  intent: ProvisionIntent,
  file: IntentFile
): Promise<void> {
  const board = await readBoardContent(read, boardId);
  if (board === null) {
    return;
  }
  intent.samples = {
    phase: 'captured',
    itemIds: board.items.map((i) => i.id),
    groupIds: board.groups.filter((g) => SAMPLE_GROUP_TITLES.has(g.title)).map((g) => g.id),
  };
  file.write(intent);
}

export interface CleanupOptions {
  /** De kolom-ids die dit script zelf aanmaakt — het bewijs dat het bord dit stadium voorbij is. */
  ourColumnIds: readonly string[];
  /** Hoe Monday's voorbeeldgroep gaat heten. Hernoemen in plaats van verwijderen: een bord moet er één houden. */
  groupTitle: string;
  log: (line: string) => void;
}

/**
 * Ruim op wat als voorbeeldinhoud is vastgelegd — en niets anders.
 *
 * De regressie die dit dichtzet: "ruim de voorbeelden op" was ooit "verwijder de eerste 50
 * items", uitgevoerd na élke `--apply`. Zodra het bord echte rijen bevat wist een herstelrun
 * dus productie.
 */
export async function cleanupSamples(
  read: BoardContentReader,
  write: Writer,
  boardId: string,
  intent: ProvisionIntent,
  file: IntentFile,
  options: CleanupOptions
): Promise<void> {
  const board = await readBoardContent(read, boardId);
  if (board === null) {
    return;
  }

  const plan = sampleCleanupPlan(
    intent.samples,
    { columnIds: board.columns.map((c) => c.id) },
    options.ourColumnIds
  );

  if (plan.kind === 'done') {
    return;
  }
  if (plan.kind === 'already_done') {
    options.log('  voorbeeldinhoud was al opgeruimd (onze kolommen bestaan)');
    intent.samples = { phase: 'cleared' };
    file.write(intent);
    return;
  }
  if (plan.kind === 'capture') {
    /**
     * FAIL CLOSED. Dit pad verwijdert nooit uit zichzelf.
     *
     * Bij een normale run kan het hier niet komen: `captureSamples` draait direct na
     * `create_board`, dus `samples` staat dan op `captured` en het plan is `delete`. Deze tak
     * is dus **uitsluitend** het herstelpad, waarop een mens `boardId` met de hand in het
     * intentiebestand heeft gezet — precies het geval waarin we geen enkel bewijs hebben dat
     * dit bord van ons is.
     *
     * Een eerdere versie leidde toestemming af uit de VORM van het bord (weinig items,
     * standaard groepsnamen). Dat is geen eigendom: Monday staat twee borden met dezelfde
     * naam toe, en een écht ander Briefings-bord met vijf rijen komt door zo'n toets heen,
     * waarna die vijf rijen verdwijnen. De vorm staat daarom alleen nog in de melding, zodat
     * een mens hem kan wegen.
     *
     * De uitweg is niet slimmer raden maar expliciet aanwijzen: de operator zet zelf in het
     * intentiebestand WELKE ids weg mogen. Dan verwijdert dit script alleen wat een mens bij
     * naam heeft genoemd.
     */
    throw new Error(
      `Bord ${boardId} staat in het intentiebestand, maar er is niet vastgelegd wat daar van ` +
        `Monday is en wat van ITG. Inhoud nu: ${describeBoardShape(board)}.\n` +
        'Er wordt NIETS verwijderd — de vorm van een bord bewijst niet dat het van ons is.\n' +
        'Kies bewust:\n' +
        '  - is het bord al ingericht? zet "samples": {"phase":"cleared"};\n' +
        '  - staat er alleen nog voorbeeldinhoud van Monday op? zet die ids er expliciet in:\n' +
        '    "samples": {"phase":"captured","itemIds":["…"],"groupIds":["…"]}\n' +
        '    Alleen díe ids worden dan verwijderd;\n' +
        '  - is dit het VERKEERDE bord? zet het juiste bord-id in "boardId".\n' +
        '    Weet je zeker dat er nooit een bord is aangemaakt? Verwijder dan het HELE\n' +
        '    intentiebestand en draai opnieuw.\n' +
        '\n' +
        '    Alleen "boardId" weghalen is niet genoeg: "startedAt" blijft dan staan, en zodra\n' +
        "    Monday's idempotency-venster (30 min) verlopen is weigert de volgende run juist\n" +
        '    daarom een nieuw bord aan te maken. Dan zit je vast.'
    );
  }

  const present = new Set(board.items.map((i) => i.id));
  for (const itemId of plan.itemIds) {
    if (!present.has(itemId)) {
      continue; // Al verwijderd in een eerdere poging.
    }
    options.log(`  voorbeelditem verwijderen: ${itemId}`);
    await write.mutate(
      'mutation ($i: ID!) { delete_item(item_id: $i) { id } }',
      { i: itemId },
      { idempotencyKey: keyFor(intent, `delete_item:${itemId}`) }
    );
  }
  for (const groupId of plan.groupIds) {
    options.log(`  groep hernoemen: ${groupId} → "${options.groupTitle}"`);
    await write.mutate(
      'mutation ($b: ID!, $g: String!, $t: String!) { update_group(board_id: $b, ' +
        'group_id: $g, group_attribute: title, new_value: $t) { id } }',
      { b: boardId, g: groupId, t: options.groupTitle },
      { idempotencyKey: keyFor(intent, `group:${groupId}`) }
    );
  }

  intent.samples = { phase: 'cleared' };
  file.write(intent);
}

export { unresolvedCreateVerdict };
