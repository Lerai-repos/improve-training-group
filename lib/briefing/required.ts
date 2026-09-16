import { BRIEFING_AGENDA_COLUMNS as C } from './columns';

/**
 * De tekstvelden van het agendabord die een briefing nodig heeft.
 *
 * Apart van `read.ts` zodat de tab ze kan tonen: daar staat per veld een vinkje, en daarvoor
 * moet de lijst van wat er gecontroleerd wordt bekend zijn, niet alleen wat er ontbreekt.
 * `read.ts` zet dezelfde lijst om in `training.missing`, dus de twee kunnen niet uit elkaar lopen.
 */
export type RequiredTextField =
  | 'opdrachtgever'
  | 'datum'
  | 'tijden'
  | 'duur'
  | 'locatie'
  | 'voertaal'
  | 'label';

export const BRIEFING_REQUIRED_FIELDS: ReadonlyArray<{
  readonly column: string;
  readonly label: string;
  readonly of: RequiredTextField;
}> = [
  { column: C.opdrachtgever, label: 'Opdrachtgever', of: 'opdrachtgever' },
  { column: C.datum, label: 'Datum', of: 'datum' },
  /** Zonder Tijden geen datum-en-tijdregel én geen materialen-deadline. */
  { column: C.tijden, label: 'Tijden', of: 'tijden' },
  { column: C.duurTekst, label: 'Duur', of: 'duur' },
  { column: C.locatie, label: 'Locatie', of: 'locatie' },
  /** Zonder Taal staat er een lege Voertaal-rij in het document. */
  { column: C.taal, label: 'Voertaal', of: 'voertaal' },
  /**
   * Het label kiest het sjabloon. Zonder label is er niets om te genereren, dus dit is
   * geen schoonheidsfoutje maar een harde voorwaarde.
   */
  { column: C.label, label: 'Label', of: 'label' },
];
