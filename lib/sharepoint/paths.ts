/**
 * Waar een briefing in SharePoint terechtkomt.
 *
 * Puur: dit rekent alleen met mappennamen. Het opvragen ervan staat erbuiten, zodat elk
 * geval dat op de echte omgeving zeldzaam is hier gewoon een test is.
 *
 * ITG's structuur, gemeten op hun eigen site:
 *
 * ```
 * Documents / General
 *   0. ITG · 1. JE · 2. TT · 3. WJ · 4. FV · 10. ST · …     ← het label
 *     5. Klanten   (of `05. klanten` — zie hieronder)
 *       2026 · 2025 · 2024                                   ← soms wel, soms niet
 *         Antonius Ziekenhuis Nieuwegein
 *           Briefing … .docx
 * ```
 *
 * Twee dingen die dit lastiger maken dan het eruitziet, allebei echt aangetroffen:
 *
 * - **Het nummer voor het label hoort bij niets.** `1. JE` maar `10. ST`, en de volgorde is
 *   historisch. Het is dus precies het deel dat we NIET als sleutel gebruiken.
 * - **`5. Klanten` heet onder TT `05. klanten`.** Zowel het nummer als de schrijfwijze
 *   verschilt per label, dus beide niveaus hebben dezelfde losse vergelijking nodig.
 */

/** `2. TT` → `TT`, `05. klanten` → `klanten`. Het nummer is de willekeurige helft. */
const NUMBER_PREFIX = /^\d+\s*[.)-]?\s*/;

/**
 * De naam waarop vergeleken wordt.
 *
 * Kleine letters, accenten eraf, leestekens eruit, spaties samengevouwen. `B.V.` en `BV`
 * worden hetzelfde, want dat verschil zegt niets over wélke klant het is.
 *
 * Wat hier NIET gebeurt is fuzzy vergelijken op afstand. Op hun eigen lijst staan
 * `Antoni van Leeuwenhoek ziekenhuis` en `Antonius Ziekenhuis Nieuwegein`: twee
 * verschillende ziekenhuizen die dicht genoeg bij elkaar liggen dat elke drempel die echte
 * typefouten opvangt, deze twee vroeg of laat op één hoop gooit. Een briefing in de map van
 * de verkeerde klant is precies de fout die niemand ziet en iedereen erg vindt.
 */
export function normaliseFolderName(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      /**
       * Twee soorten leestekens, en het verschil is niet cosmetisch.
       *
       * Punten en apostrofs staan bínnen een woord: `B.V.` is één woord en moet gelijk
       * worden aan `BV`. Vervang je ze door een spatie, dan wordt het `b v` en matcht
       * `BPD Europe B.V.` nooit met `BPD Europe BV` — precies de klant die op hun lijst
       * staat.
       *
       * Streepjes en schuine strepen scheiden juist wél woorden: `Actief-Werkt` hoort
       * gelijk te worden aan `Actief Werkt`, niet aan `ActiefWerkt`.
       */
      .replace(/[.,!?'"`´]/g, '')
      .replace(/[()[\]{}&+_/\\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Dezelfde vergelijking, maar met het nummer er eerst af. Voor label- en klantenmappen. */
export function normaliseNumbered(name: string): string {
  return normaliseFolderName(name.replace(NUMBER_PREFIX, ''));
}

/**
 * Wat het zoeken naar één map oplevert.
 *
 * `ambiguous` is een eigen uitkomst en geen "pak de eerste". Twee mappen die na normalisatie
 * hetzelfde heten betekent dat er iets is dat wij niet weten, en dan is stoppen met een
 * duidelijke melding beter dan een gok die eruitziet als een antwoord.
 */
export type FolderMatch =
  | { readonly kind: 'found'; readonly name: string }
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'missing' };

function matchOn(
  children: readonly string[],
  wanted: string,
  normalise: (name: string) => string
): FolderMatch {
  const doel = normalise(wanted);
  if (doel === '') {
    return { kind: 'missing' };
  }
  const treffers = children.filter((naam) => normalise(naam) === doel);
  if (treffers.length === 0) {
    return { kind: 'missing' };
  }
  if (treffers.length > 1) {
    return { kind: 'ambiguous', names: treffers };
  }
  return { kind: 'found', name: treffers[0] };
}

/** `TT` vindt `2. TT`; het nummer telt niet mee. */
export function matchLabelFolder(children: readonly string[], label: string): FolderMatch {
  return matchOn(children, label, normaliseNumbered);
}

/** Vindt `5. Klanten` én `05. klanten`, en verder niets. */
export function matchKlantenFolder(children: readonly string[]): FolderMatch {
  return matchOn(children, 'Klanten', normaliseNumbered);
}

/**
 * Het jaar van de sessie, als er een jaarmap is.
 *
 * Onder TT staat élke klant in een jaarmap, onder JE staan de huidige klanten los en zijn
 * alleen `2025` en `2024` gearchiveerd. Beide moeten werken, en zodra iemand JE opruimt
 * gebruiken we die mappen vanzelf — zonder dat er iets aan de code verandert.
 *
 * Het jaar van de TRAINING, niet van vandaag: een sessie in januari 2027 die we in 2026
 * genereren hoort bij 2027. Hun eigen indeling zegt dat ook, want de jaarmappen staan naast
 * de lopende klanten in plaats van eromheen.
 *
 * Geen nummerprefix hier: een jaarmap heet gewoon `2026`.
 */
export function matchYearFolder(children: readonly string[], jaar: string): FolderMatch {
  return matchOn(children, jaar, normaliseFolderName);
}

/** De klantmap, ergens tussen deze kinderen. */
export function matchClientFolder(children: readonly string[], klant: string): FolderMatch {
  return matchOn(children, klant, normaliseFolderName);
}

/**
 * De tekens die Windows en SharePoint weigeren in de naam van een map of bestand.
 *
 * Spaties en streepjes staan er bewust **niet** bij: ITG schrijft zijn eigen mappen en
 * briefings zo, en dat is de naam die zij herkennen.
 */
const UNSAFE_IN_NAME = /[\\/:*?"<>|]/g;

/**
 * Een klantnaam uit Monday als naam die SharePoint accepteert.
 *
 * De schuine streep is de gevaarlijke: `Gemeente Ede / Wageningen` zou als mapnaam geen map
 * `Gemeente Ede - Wageningen` opleveren maar een map `Gemeente Ede` mét een map `Wageningen`
 * erin. Het staat niet voor niets als acceptatiecriterium in `06-briefing.md`.
 *
 * Dit raakt alleen het AANMAKEN. Voor het herkennen van een bestaande map is het niet nodig:
 * `normaliseFolderName` maakt van zowel `/` als `-` een spatie, dus Monday's schrijfwijze en
 * die van de map komen daar sowieso op hetzelfde uit.
 */
export function sanitiseItemName(naam: string): string {
  return (
    naam
      .replace(UNSAFE_IN_NAME, '-')
      .replace(/\s+/g, ' ')
      .trim()
      /**
       * Ook de RANDEN, en dat is geen theoretisch geval.
       *
       * SharePoint weigert een naam die op een punt eindigt of met een tilde begint. `B.V.`
       * is de gebruikelijkste Nederlandse achtervoeging die er is, dus `Nieuwe Klant B.V.`
       * zou de allereerste keer dat we een map voor zo'n klant moeten aanmaken meteen falen
       * — en dat pad is juist bedoeld om zonder gedoe te werken.
       *
       * De punt gaat eraf en niet om in een streepje: `Nieuwe Klant B.V-` leest als een
       * typefout, `Nieuwe Klant B.V` als dezelfde naam.
       */
      .replace(/^~+/, '')
      .replace(/\.+$/, '')
      .trim()
  );
}

/** Het jaar uit een `YYYY-MM-DD`, of null als er geen bruikbare datum is. */
export function yearOfDate(isoDatum: string | null): string | null {
  if (isoDatum === null) {
    return null;
  }
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(isoDatum.trim());
  return match === null ? null : match[1];
}
