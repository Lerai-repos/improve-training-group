/**
 * Welk Systeem-bord er beschreven wordt.
 *
 * Losser dan het Labels- en Instellingen-bord: die worden GELEZEN en sturen de uitkomst van
 * rapporten aan, dus daar is een override in productie fataal en verboden. Dit bord wordt
 * alleen BESCHREVEN. Een override die per ongeluk blijft staan levert meldingen op een testbord
 * op — vervelend, en zichtbaar zodra iemand kijkt, maar het verandert geen enkel document.
 *
 * Daarom mag de override hier ook in productie bestaan. Wat NIET mag is een leeg bord-id: dat
 * levert bij Monday geen fout op maar een lege lijst, en dan leest een run als "er staat nog
 * niets op het bord" en plaatst hij elke melding opnieuw.
 */

/**
 * Aangemaakt door `pnpm systeem:create --apply` op 4-Sep-2026, werkruimte 5308763.
 *
 * Expliciet `string` en niet het letterlijke type, zodat de leeg-controle hieronder blijft
 * bestaan in plaats van door TypeScript als onbereikbaar te worden wegbewezen. Zelfde reden
 * als bij `LABELS_PRODUCTION_BOARD`.
 */
export const SYSTEEM_PRODUCTION_BOARD: string = '5103547017';

const OVERRIDE = 'MONDAY_SYSTEEM_BOARD_ID';

type Env = Record<string, string | undefined>;

export function systeemBoardId(env: Env = process.env): string {
  const configured = env[OVERRIDE]?.trim() ?? '';
  if (configured !== '') {
    return configured;
  }
  if (SYSTEEM_PRODUCTION_BOARD !== '') {
    return SYSTEEM_PRODUCTION_BOARD;
  }
  throw new Error(
    'Geen Systeem-bord bekend. Draai `pnpm systeem:create --apply` en vul ' +
      `SYSTEEM_PRODUCTION_BOARD in lib/signals/board.ts, of zet ${OVERRIDE}.`
  );
}
