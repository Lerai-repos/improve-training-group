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
