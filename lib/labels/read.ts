import { LABEL_COLUMNS } from './columns';
import { isLabelCode } from './catalog';
import { describeProblem, validateCatalog } from './validate';

import type { LabelCode, LabelConfig } from './types';

/**
 * Het Labels-bord lezen: negen rijen, tien kolommen, één keer per rapportrun.
 *
 * Fail-closed, net als de Instellingen-lezer. Een halve labelconfiguratie levert geen halve
 * fout op maar een compleet, professioneel ogend rapport in de verkeerde huisstijl — en dat is
 * precies het soort resultaat waar niemand naar kijkt.
 */

/**
 * Een afbeelding uit een bestandskolom.
 *
 * **`publicUrl` is een uur geldig en verder niets.** Hij hoort nooit in een opgeslagen
 * document, een cache of een gerenderde HTML te belanden: haal het bestand binnen zodra je de
 * URL hebt en zet de inhoud er als data-URI in. Een link die morgen 403 geeft ziet er vandaag
 * uit als een werkend rapport.
 */
export interface LabelAsset {
  readonly id: string;
  readonly name: string;
  readonly publicUrl: string;
}

export interface LabelRecord extends LabelConfig {
  readonly logo: LabelAsset | null;
  readonly voorblad: LabelAsset | null;
  readonly achterblad: LabelAsset | null;
}

interface AssetCell {
  asset?: { id: string; name?: string | null; public_url?: string | null } | null;
}

interface LabelCell {
  id: string;
  text?: string | null;
  /** Alleen op link-kolommen, via het typed `LinkValue`-fragment. */
  url?: string | null;
  /** Alleen op bestandskolommen. */
  files?: AssetCell[] | null;
}

interface LabelItem {
  id: string;
  name: string;
  column_values?: LabelCell[] | null;
}

/**
 * Concreet getypeerd in plaats van `query<T>(): Promise<T>`.
 *
 * Die generieke vorm belooft iets wat geen implementatie kan waarmaken zonder cast, en dwingt
 * elke testdubbel dezelfde cast op — juist daar waar zichtbaar moet zijn dat de vorm klopt.
 */
interface LabelsReader {
  query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ boards?: Array<{ items_page?: { items?: LabelItem[] | null } | null }> | null }>;
}

const COLUMN_IDS = Object.values(LABEL_COLUMNS);

/**
 * De projectie.
 *
 * Link-kolommen via `url` en niet via `text`: `text` is de zichtbare tekst, die iemand kan
 * hebben overschreven met "klik hier". De bestandskolommen halen `public_url` in dezelfde
 * vraag op, zodat er geen tweede ronde nodig is voor de afbeeldingen.
 */
function itemFields(): string {
  return (
    `id name column_values(ids: [${COLUMN_IDS.map((id) => `"${id}"`).join(', ')}]) { ` +
    `id text ` +
    `... on LinkValue { url } ` +
    `... on FileValue { files { ... on FileAssetValue { ` +
    `asset { id name public_url } } } } }`
  );
}

const cell = (item: LabelItem, id: string): LabelCell | undefined =>
  (item.column_values ?? []).find((c) => c.id === id);

const textOf = (item: LabelItem, id: string): string => (cell(item, id)?.text ?? '').trim();

/** Een link-kolom levert zijn waarde in `url`; leeg is een geldige toestand. */
const linkOf = (item: LabelItem, id: string): string => (cell(item, id)?.url ?? '').trim();

type AssetResult =
  | { kind: 'none' }
  | { kind: 'one'; asset: LabelAsset }
  /** Meer dan één bruikbaar bestand: welke het merk is, is niet uit te maken. */
  | { kind: 'ambiguous'; names: readonly string[] };

/**
 * Het ENE bestand in een kolom, of de constatering dat het er niet één is.
 *
 * **Waarom `files[0]` fout is.** Een Monday-bestandskolom is een lijst, en uploaden VOEGT TOE.
 * Wie een nieuw voorblad uploadt zonder het oude te verwijderen krijgt er twee, en de eerste
 * pakken betekent dan dat elk rapport het oude blad blijft tonen — met een nieuw bestand
 * zichtbaar in de kolom dat bewijst dat het vervangen is. Dat is precies de plausibele
 * onjuistheid waar deze module op gebouwd is om te weigeren.
 *
 * Ook niet "de nieuwste": `created_at` is er wel, maar dan is de vervangregel impliciet en
 * werkt hij pas als iemand hem toevallig zo gebruikt. Twee bestanden is een vraag aan een
 * mens, en die kost één klik.
 */
function assetOf(item: LabelItem, id: string): AssetResult {
  const usable: LabelAsset[] = [];
  for (const file of cell(item, id)?.files ?? []) {
    const asset = file.asset;
    if (asset === undefined || asset === null) {
      continue;
    }
    const publicUrl = (asset.public_url ?? '').trim();
    if (publicUrl === '') {
      // Het bestand staat er wel maar Monday geeft geen URL. Overslaan is beter dan een lege
      // string doorgeven die verderop een mislukte download wordt.
      continue;
    }
    usable.push({ id: asset.id, name: (asset.name ?? '').trim(), publicUrl });
  }

  if (usable.length === 0) {
    return { kind: 'none' };
  }
  if (usable.length === 1) {
    return { kind: 'one', asset: usable[0] };
  }
  return { kind: 'ambiguous', names: usable.map((a) => (a.name === '' ? a.id : a.name)) };
}

/** De drie bestandskolommen met hun leesbare naam, voor de foutmelding. */
const ASSET_COLUMNS = [
  [LABEL_COLUMNS.logo, 'Logo'],
  [LABEL_COLUMNS.voorblad, 'Voorblad'],
  [LABEL_COLUMNS.achterblad, 'Achterblad'],
] as const;

function toRecord(
  item: LabelItem,
  code: LabelCode
): { record: LabelRecord; ambiguous: string[] } {
  const ambiguous: string[] = [];
  const assets: Record<string, LabelAsset | null> = {};

  for (const [columnId, title] of ASSET_COLUMNS) {
    const result = assetOf(item, columnId);
    if (result.kind === 'ambiguous') {
      ambiguous.push(
        `${code}: de kolom ${title} bevat ${result.names.length} bestanden ` +
          `(${result.names.join(', ')}) — laat er één staan`
      );
      assets[columnId] = null;
      continue;
    }
    assets[columnId] = result.kind === 'one' ? result.asset : null;
  }

  return {
    record: {
      code,
      volledigeNaam: textOf(item, LABEL_COLUMNS.volledigeNaam),
      kleur: textOf(item, LABEL_COLUMNS.kleur),
      term: textOf(item, LABEL_COLUMNS.term),
      rapportterm: textOf(item, LABEL_COLUMNS.rapportterm),
      evaluatieformulier: linkOf(item, LABEL_COLUMNS.evaluatieformulier),
      website: linkOf(item, LABEL_COLUMNS.website),
      inventarisatieformulier: linkOf(item, LABEL_COLUMNS.inventarisatieformulier),
      logo: assets[LABEL_COLUMNS.logo] ?? null,
      voorblad: assets[LABEL_COLUMNS.voorblad] ?? null,
      achterblad: assets[LABEL_COLUMNS.achterblad] ?? null,
    },
    ambiguous,
  };
}

/**
 * Zet de ruwe items om, zonder Monday. Apart zodat de vertaling getest kan worden.
 *
 * De itemnaam IS de labelcode — dat is hoe `02-datamodel-monday.md` het bord specificeert.
 * Een rij met een naam die geen labelcode is komt er als `unknown` uit in plaats van te
 * worden overgeslagen: stil negeren zou een verkeerd gespelde `SST ` laten verdwijnen en het
 * label als ontbrekend melden, wat naar de verkeerde reparatie wijst.
 */
export function mapLabelItems(items: readonly LabelItem[]): {
  records: LabelRecord[];
  unknown: string[];
  ambiguous: string[];
} {
  const records: LabelRecord[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const item of items) {
    const code = item.name.trim();
    if (!isLabelCode(code)) {
      unknown.push(code);
      continue;
    }
    const mapped = toRecord(item, code);
    records.push(mapped.record);
    ambiguous.push(...mapped.ambiguous);
  }
  return { records, unknown, ambiguous };
}

/**
 * Lees het bord en weiger als het niet klopt.
 *
 * Werpt in plaats van een deelresultaat terug te geven, om dezelfde reden als `readSettings`:
 * de aanroeper is een generatiestap die anders vrolijk doorloopt.
 */
export async function readLabels(
  client: LabelsReader,
  boardId: string
): Promise<ReadonlyMap<LabelCode, LabelRecord>> {
  const data = await client.query(
    `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 100) { items { ${itemFields()} } } } }`,
    { b: [boardId] }
  );

  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Labels-bord ${boardId} niet gevonden.`);
  }

  const { records, unknown, ambiguous } = mapLabelItems(board.items_page?.items ?? []);
  const problems = validateCatalog(records);

  if (problems.length > 0 || unknown.length > 0 || ambiguous.length > 0) {
    const lines = [
      ...problems.map(describeProblem),
      ...unknown.map((name) => `"${name}": rij zonder geldige labelcode als naam`),
      ...ambiguous,
    ];
    throw new Error(
      `Het Labels-bord (${boardId}) klopt niet:\n  ${lines.join('\n  ')}\n` +
        'Zonder een kloppende labelconfiguratie wordt een rapport in de verkeerde huisstijl ' +
        'gerenderd, en dat is aan het resultaat niet te zien.'
    );
  }

  return new Map(records.map((r) => [r.code, r]));
}
