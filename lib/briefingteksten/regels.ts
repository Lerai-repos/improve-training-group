import type { TekstRegel } from './types';

/**
 * Van wat iemand in Monday typt naar regels voor het sjabloon.
 *
 * Een `long_text`-kolom kent alleen "nieuwe regel", geen opmaak. Dat is hier een voordeel:
 * plakken uit Word neemt geen lettertypes of kleuren mee. De afspraak is klein genoeg om uit
 * te leggen in één zin op het bord:
 *
 * | Regel begint met | Wordt |
 * |---|---|
 * | niets | een alinea |
 * | `-` (of `•`, `*`, `–`, `·`) | een opsommingsregel |
 * | `--` (of een ingesprongen `-`) | een opsommingsregel één niveau dieper |
 *
 * Lege regels vallen weg. De witruimte tussen secties komt uit het sjabloon, dus een extra
 * witregel in Monday kan de opmaak van het document niet veranderen.
 */

/** De tekens waarmee Word, Google Docs en een toetsenbord een opsomming beginnen. */
const OPSOMMING = /^([-•*–·])\s*/;
/** Twee streepjes: expliciet één niveau dieper. */
const DIEPER = /^--\s*/;
/** Een ingesprongen opsommingsteken: zo komt een geneste lijst uit Word binnen. */
const INGESPRONGEN = /^(?:\t|\s{2,})[-•*–·o]\s+/;

/** Harde spaties en tabs worden gewone spaties, en reeksen spaties worden er één. */
function normaliseer(tekst: string): string {
  return tekst
    .replace(/[   \t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function regel(ruw: string): TekstRegel | null {
  if (DIEPER.test(ruw.trimStart())) {
    const tekst = normaliseer(ruw.trimStart().replace(DIEPER, ''));
    return tekst === '' ? null : { tekst, bullet: true, niveau: 1 };
  }
  if (INGESPRONGEN.test(ruw)) {
    const tekst = normaliseer(ruw.replace(INGESPRONGEN, ''));
    return tekst === '' ? null : { tekst, bullet: true, niveau: 1 };
  }
  const begin = ruw.trimStart();
  if (OPSOMMING.test(begin)) {
    const tekst = normaliseer(begin.replace(OPSOMMING, ''));
    return tekst === '' ? null : { tekst, bullet: true, niveau: 0 };
  }
  const tekst = normaliseer(ruw);
  return tekst === '' ? null : { tekst, bullet: false, niveau: 0 };
}

/**
 * De tekst als regels, zonder lege.
 *
 * Monday geeft `\n` terug, en `\r\n` als er uit Word geplakt is.
 */
export function parseRegels(tekst: string): readonly TekstRegel[] {
  return tekst.split(/\r?\n/).flatMap((ruw) => {
    const r = regel(ruw);
    return r === null ? [] : [r];
  });
}

/** Eén regel tekst, zoals een kop: witruimte opgeschoond. */
export function parseKop(kop: string): string {
  return normaliseer(kop.replace(/\r?\n/g, ' '));
}
