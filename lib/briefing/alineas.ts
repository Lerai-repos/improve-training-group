/**
 * Alinea's terug in een lang tekstveld van Monday.
 *
 * Monday levert een enter in een long-text-kolom niet als regeleinde maar als twee spaties,
 * in `text` én in `value`. Gemeten 12-Oct-2026 op de Opportunity-achtergrond: 44 teksten, 0
 * met een regeleinde, 118 keer twee of meer spaties na een leesteken. Zonder dit staat in de
 * tab en in het document één lap tekst, en zoeken de werkstudenten waar de volgende alinea
 * begint (Dirkje, 12-Oct-2026).
 *
 * Twee of meer spaties worden dus een nieuwe alinea, behalve vóór een kleine letter: dat is een
 * tikfout midden in een zin ("ongeveer 2  beschikbaar", de enige zo gemeten), geen enter.
 * Een kopje dat met één spatie aan de zin erna vastzit ("Aanleiding Binnen het team") blijft
 * vast: één spatie is niet van een gewone zin te onderscheiden.
 */
export function herstelAlineas(tekst: string): string {
  return tekst
    .split('\n')
    .flatMap((regel) => regel.split(/ {2,}(?=[^\sa-zà-ÿ])/))
    .map((alinea) => alinea.trim())
    .filter((alinea) => alinea !== '')
    .join('\n');
}
