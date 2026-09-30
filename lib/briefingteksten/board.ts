/**
 * Welk bord de briefingteksten levert.
 *
 * Streng zoals het Labels-bord: dit bord bepaalt wat er in elk document staat, dus een lege
 * waarde mag nooit stil "geen teksten" betekenen. Monday geeft voor een onbekend bord een lege
 * lijst terug, en dan zou elke sectie als verwijderd lezen en verdwijnen.
 */

/**
 * Aangemaakt door `pnpm briefingteksten:create --apply` op 30-Sep-2026, werkruimte 5308763.
 *
 * Expliciet `string` en niet het letterlijke type, zodat de leeg-controle hieronder niet door
 * TypeScript als onbereikbaar wordt wegbewezen. Zelfde reden als bij `LABELS_PRODUCTION_BOARD`.
 */
export const BRIEFINGTEKSTEN_PRODUCTION_BOARD: string = '5105219273';

const OVERRIDE = 'MONDAY_BRIEFINGTEKSTEN_BOARD_ID';

type Env = Record<string, string | undefined>;

export function briefingtekstenBoardId(env: Env = process.env): string {
  const configured = env[OVERRIDE]?.trim() ?? '';
  if (configured !== '') {
    return configured;
  }
  if (BRIEFINGTEKSTEN_PRODUCTION_BOARD !== '') {
    return BRIEFINGTEKSTEN_PRODUCTION_BOARD;
  }
  throw new Error(
    'Geen Briefingteksten-bord bekend. Draai `pnpm briefingteksten:create --apply` en vul ' +
      `BRIEFINGTEKSTEN_PRODUCTION_BOARD in lib/briefingteksten/board.ts, of zet ${OVERRIDE}.`
  );
}
