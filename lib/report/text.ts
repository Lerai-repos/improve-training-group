/**
 * De tekstregels die per rapport verschillen: namen, meervouden, en het ontsnappen van
 * wat een deelnemer heeft ingetypt.
 */

/** Onder deze grens is het enkelvoud: "onze trainer" tegenover "onze trainers". */
const SINGLE = 1;

/**
 * Nederlandse opsomming: "Jan", "Jan en Piet", "Jan, Piet en Klaas".
 *
 * Geen Oxford-komma en geen "&" — dit staat middenin een lopende zin in een brief aan een
 * klant.
 */
export function joinDutch(names: readonly string[]): string {
  const clean = names.map((n) => n.trim()).filter((n) => n !== '');
  if (clean.length === 0) {
    return '';
  }
  if (clean.length === SINGLE) {
    return clean[0];
  }
  return `${clean.slice(0, -1).join(', ')} en ${clean[clean.length - 1]}`;
}

/** "trainer" of "trainers", afhankelijk van hoeveel er voor de groep stonden. */
export function trainerWord(count: number): string {
  return count > SINGLE ? 'trainers' : 'trainer';
}

/**
 * De voornamen uit het contactpersoonveld van Monday.
 *
 * Dat veld bevat "Lisa de Vries, Mark Jansen" — meerdere mensen, komma-gescheiden, met
 * achternaam. De aanhef gebruikt alleen voornamen, zoals ITG hem zelf schrijft.
 */
export function firstNames(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((n) => n !== '');
}

/**
 * Tekst van een deelnemer, veilig in HTML.
 *
 * **Dit is de enige plek waar deelnemersinvoer het document in gaat**, en het is letterlijk
 * wat iemand in een Google Form heeft getypt. De bestaande generator ontsnapt alleen `"` en
 * `<`; dat laat `&` staan, waardoor `&amp;` in een citaat als `&` wordt weergegeven en
 * `<script` na één vervanging alsnog `&lt;script` had moeten zijn. Hier gaan alle vijf.
 *
 * De volgorde is niet vrij: `&` MOET eerst, anders ontsnapt hij de `&` die de andere
 * vervangingen zelf net hebben neergezet.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
