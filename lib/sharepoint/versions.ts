/**
 * Een tweede briefing naast de eerste, in plaats van eroverheen.
 *
 * ITG bewerkt het gegenereerde Word-bestand met de hand — extra tekst, en soms een plaatje
 * van hoe een 2 × 4-uurstraject in de offerte stond. Dat bestand ís het bestand dat wij
 * schrijven, dus opnieuw genereren zou hun werk wissen. SharePoint bewaart de vorige versie
 * wel, maar stilzwijgend, en niemand gaat daar kijken.
 *
 * Dus: nooit overschrijven. Bestaat hij al, dan komt er een versie naast.
 */

const DOCX = '.docx';

/**
 * `(v2)` en niet ` 2`, hoewel ITG dat laatste zelf doet.
 *
 * Hun eigen map bevat `… - 14-04-2026 - Ellis.docx` naast `… - 14-4-2026 - Ellis 2.docx`,
 * met twee verschillende datumnotaties. Aan die `2` is niet te zien of het een tweede
 * versie, een tweede sessie of een tweede trainer is — precies de verwarring die we niet
 * willen erven. `(v2)` kan maar één ding betekenen en sorteert naast het origineel.
 */
const VERSION_SUFFIX = /^(.*?)\s*\(v(\d+)\)$/;

interface Ontleed {
  readonly stam: string;
  readonly versie: number;
}

/** `Briefing X (v3).docx` → stam `Briefing X`, versie 3. Zonder achtervoegsel: versie 1. */
function ontleed(bestandsnaam: string): Ontleed | null {
  if (!bestandsnaam.toLowerCase().endsWith(DOCX)) {
    return null;
  }
  const zonderExt = bestandsnaam.slice(0, -DOCX.length);
  const match = VERSION_SUFFIX.exec(zonderExt);
  return match === null
    ? { stam: zonderExt, versie: 1 }
    : { stam: match[1], versie: Number(match[2]) };
}

/** SharePoint kijkt niet naar hoofdletters bij bestandsnamen, dus wij ook niet. */
const gelijk = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `09-10-2026` en `9-10-2026`, zoals `briefingFilename` ze schrijft. */
const DATUM_IN_NAAM = /\b\d{1,2}-\d{1,2}-\d{4}\b/g;

/**
 * De naam zonder de datum, om briefings van dezelfde sessie te herkennen.
 *
 * De volledige stam bevat de datum, en dat is precies het veld dat verandert wanneer een
 * sessie verschoven wordt. Daarop vergelijken maakte `relatedBriefings` blind voor het énige
 * geval waarvoor het bestaat: de bewerkte briefing van de oude datum blijft liggen, botst
 * nergens mee, en werd niet getoond.
 *
 * Klant, thema en trainer blijven wél in de sleutel, dus een briefing voor een andere
 * trainer of een ander thema hoort hier nooit bij.
 */
function relatieSleutel(stam: string): string {
  return stam
    .replace(DATUM_IN_NAAM, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/(\s*-\s*)+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Welke naam dit bestand krijgt, gegeven wat er al in de map staat.
 *
 * Is de naam vrij, dan die. Anders de hoogste bestaande versie plus één — en níet het
 * eerste gaatje. Een verwijderde `(v2)` weer opvullen zou een verse briefing tussen twee
 * oudere zetten, waar de volgorde in de map dan niets meer over de volgorde in de tijd zegt.
 */
export function nextVersionName(gewenst: string, bestaande: readonly string[]): string {
  const doel = ontleed(gewenst);
  if (doel === null) {
    return gewenst;
  }
  const versies = bestaande
    .map(ontleed)
    .filter((b): b is Ontleed => b !== null && gelijk(b.stam, doel.stam))
    .map((b) => b.versie);

  if (versies.length === 0) {
    return gewenst;
  }
  return `${doel.stam} (v${Math.max(...versies) + 1})${DOCX}`;
}

/** Staat er al een briefing met precies deze naam? Bepaalt of er bevestigd moet worden. */
export function alreadyExists(gewenst: string, bestaande: readonly string[]): boolean {
  return bestaande.some((naam) => gelijk(naam, gewenst));
}

/**
 * Alle briefings van dezelfde training die er al staan, ongeacht versie.
 *
 * Gebruikt om in de tab te tonen wát er al ligt. Vangt óók het geval dat de exacte
 * naamcontrole mist: verschuift de datum, dan verandert de bestandsnaam en botst er niets,
 * terwijl de bewerkte briefing van de oude datum gewoon blijft staan. Zichtbaar maken is
 * genoeg — de adviseur ziet zelf welke weg moet.
 */
export function relatedBriefings(gewenst: string, bestaande: readonly string[]): readonly string[] {
  const doel = ontleed(gewenst);
  if (doel === null) {
    return [];
  }
  const sleutel = relatieSleutel(doel.stam);
  return bestaande.filter((naam) => {
    const b = ontleed(naam);
    return b !== null && gelijk(relatieSleutel(b.stam), sleutel);
  });
}
