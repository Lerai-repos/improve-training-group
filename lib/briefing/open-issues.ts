/**
 * De regels die in het document komen te staan waar iets nog niet klaar is.
 *
 * Twee soorten, en het verschil doet ertoe voor wie het oplost:
 *
 * - **niet aangesloten** — wij hebben die bron nog niet gebouwd of hij is nog geblokkeerd
 * - **niet bepaald** — de bron werkt, maar Monday zegt zelf dat het antwoord nog niet
 *   vaststaat, en dan mag er geen stellige zin in de briefing komen
 *
 * Allebei staan ze tussen guillemets. Dat is geen opsmuk: `«` komt in geen enkele echte
 * briefingtekst voor, dus het is een betrouwbaar zoekpatroon om te controleren dat er niets
 * onafs de deur uitgaat. `openIssues` in `compose.ts` verzamelt ze op die manier.
 *
 * Staat hier apart van `compose.ts` omdat `blocks.ts` en `format.ts` ze allebei nodig
 * hebben, en die worden juist dóór `compose.ts` geïmporteerd.
 */

/** Het teken waaraan een onaffe regel te herkennen is. */
export const OPEN_ISSUE_MARK = '«';

/** `« nog niet aangesloten: achtergrondinformatie — bron: Briefings-board »` */
export function notConnected(wat: string, bron: string): string {
  return `${OPEN_ISSUE_MARK} nog niet aangesloten: ${wat} — bron: ${bron} »`;
}

/** `« nog niet bepaald: evaluatie deelnemers — de QR-kolom staat op "0. NOTK" »` */
export function notDecided(wat: string, reden: string): string {
  return `${OPEN_ISSUE_MARK} nog niet bepaald: ${wat} — ${reden} »`;
}

/** Is dit een van bovenstaande regels, en dus geen tekst die naar een trainer mag? */
export function isOpenIssue(tekst: string): boolean {
  return tekst.trimStart().startsWith(OPEN_ISSUE_MARK);
}

const NOT_DECIDED_PREFIX = `${OPEN_ISSUE_MARK} nog niet bepaald: `;

/**
 * Is dit iets wat de adviseur kan oplossen?
 *
 * Alleen `nog niet bepaald` telt. `nog niet aangesloten` is ónze achterstand — de
 * inventarisatiebron bijvoorbeeld bestaat nog niet — en daar kan niemand bij ITG iets aan
 * doen. Telt die mee, dan is een briefing nooit compleet en zegt `Staat klaar` niets meer.
 */
export function isNotDecided(tekst: string): boolean {
  return tekst.trimStart().startsWith(NOT_DECIDED_PREFIX);
}

/** `« nog niet bepaald: evaluatie deelnemers — reden »` → `Evaluatie deelnemers: reden`. */
export function describeOpenIssue(tekst: string): string {
  const kern = tekst
    .trim()
    .replace(/^«\s*nog niet (bepaald|aangesloten):\s*/, '')
    .replace(/\s*»$/, '')
    .replace(' — ', ': ');
  return kern.charAt(0).toUpperCase() + kern.slice(1);
}

/** `« nog niet bepaald: evaluatie deelnemers — reden »` → `{ wat: 'Evaluatie deelnemers', reden }`. */
export function splitOpenIssue(tekst: string): { readonly wat: string; readonly reden: string } {
  const kern = describeOpenIssue(tekst);
  const scheiding = kern.indexOf(': ');
  return scheiding < 0
    ? { wat: kern, reden: '' }
    : { wat: kern.slice(0, scheiding), reden: kern.slice(scheiding + 2) };
}
