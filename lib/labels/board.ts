/**
 * Welk Labels-bord er gelezen wordt.
 *
 * Zelfde contract als het Instellingen-bord: in productie MOET de omgevingsvariabele
 * ontbreken. Een override die per ongeluk op een testbord blijft staan zou anders elk rapport
 * in de verkeerde huisstijl zetten — met kleuren en namen die er volstrekt normaal uitzien
 * voor wie het merk niet dagelijks ziet. Vandaar dat het hier wordt afgedwongen en niet alleen
 * in het inrichtingsscript.
 */

/**
 * Aangemaakt door `pnpm labels:create --apply` op 1-Sep-2026, werkruimte 5308763.
 *
 * Was leeg tot het bord bestond, en dat is met opzet een fail-closed toestand: de
 * configuratie lezen vóórdat het bord er is hoort te klagen, niet bord `""` te bevragen.
 */
/**
 * Expliciet `string` en niet het letterlijke type: anders bewijst TypeScript dat de
 * leeg-controles hieronder nooit waar zijn en vallen ze weg. Die controles zijn juist de
 * fail-closed grendel voor de toestand waarin iemand dit veld leegmaakt of het bord opnieuw
 * moet worden aangemaakt. `INSTELLINGEN_PRODUCTION` doet hetzelfde via zijn interface.
 */
export const LABELS_PRODUCTION_BOARD: string = '5103340139';

const OVERRIDE = 'MONDAY_LABELS_BOARD_ID';

type Env = Record<string, string | undefined>;

/** `VERCEL_ENV` is wat Vercel zelf zet; de lokale `.env.local` heeft hem niet. */
function isProductionDeployment(env: Env): boolean {
  return env.VERCEL_ENV === 'production';
}

/**
 * Het bord-id, of een uitleg waarom er geen is.
 *
 * Werpt in plaats van een lege string terug te geven: een leeg bord-id levert bij Monday een
 * lege lijst op in plaats van een fout, en dat leest als "er zijn geen labels" — precies het
 * soort plausibele leegte waar de rest van deze codebase op gebouwd is om te weigeren.
 */
export function labelsBoardId(env: Env = process.env): string {
  const configured = env[OVERRIDE]?.trim() ?? '';

  if (isProductionDeployment(env)) {
    if (OVERRIDE in env) {
      throw new Error(
        `${OVERRIDE} mag in productie niet bestaan — productie leest altijd het vastgezette ` +
          'bord. Haal de variabele weg uit de productieomgeving.'
      );
    }
    if (LABELS_PRODUCTION_BOARD === '') {
      throw new Error(
        'LABELS_PRODUCTION_BOARD is nog niet ingevuld. Draai `pnpm labels:create --apply` en ' +
          'zet het gemelde id in lib/labels/board.ts.'
      );
    }
    return LABELS_PRODUCTION_BOARD;
  }

  if (configured !== '') {
    return configured;
  }
  if (LABELS_PRODUCTION_BOARD !== '') {
    return LABELS_PRODUCTION_BOARD;
  }
  throw new Error(
    'Geen Labels-bord bekend. Draai `pnpm labels:create --apply` en vul ' +
      `LABELS_PRODUCTION_BOARD in, of zet ${OVERRIDE} voor een eigen bord.`
  );
}
