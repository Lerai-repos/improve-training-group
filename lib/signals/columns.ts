import type { ExpectedColumn } from '@lib/monday/board-config';
import type { Soort } from './types';

/**
 * De kolom-ids op het Systeem-bord. Ids, geen titels — iedereen met bordtoegang mag hernoemen.
 */
export const SIGNAL_COLUMNS = {
  tijdstip: 'itg_tijdstip',
  soort: 'itg_soort',
  onderdeel: 'itg_onderdeel',
  detail: 'itg_detail',
  afgehandeld: 'itg_afgehandeld',
  sleutel: 'itg_sleutel',
  afgehandeldDoor: 'itg_afgehandeld_door',
} as const;

/**
 * Wat er in `Afgehandeld door` staat als de controle zélf heeft afgevinkt.
 *
 * Leeg betekent: een mens heeft het vinkje gezet. Dat onderscheid is de hele reden dat deze
 * kolom bestaat — zie `reconcile.ts`. Een melding die wij afvinkten omdat het probleem wég was
 * moet terugkomen als het probleem terugkomt; een melding die ITG bewust wegzette niet.
 */
export const CLOSED_BY_CHECK = 'controle';

export const SIGNAL_EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { id: SIGNAL_COLUMNS.tijdstip, type: 'date' },
  { id: SIGNAL_COLUMNS.soort, type: 'status' },
  { id: SIGNAL_COLUMNS.onderdeel, type: 'text' },
  { id: SIGNAL_COLUMNS.detail, type: 'long_text' },
  { id: SIGNAL_COLUMNS.afgehandeld, type: 'checkbox' },
  { id: SIGNAL_COLUMNS.sleutel, type: 'text' },
  { id: SIGNAL_COLUMNS.afgehandeldDoor, type: 'text' },
];

/**
 * De labels van de statuskolom `Soort`, met hun index.
 *
 * Begint bij 1. Index 5 is Monday's ingebouwde lege plek en wordt overal in deze codebase
 * vermeden, want daar schrijven betekent "leeg" en niet "de vijfde keuze".
 */
export const SOORT_LABELS: Readonly<Record<number, Soort>> = {
  1: 'Foutmelding',
  2: 'Signalering',
  3: 'Dagsamenvatting',
};

export interface SignalColumnSpec {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** `create_column(defaults:)` — alleen de statuskolom heeft er een. */
  readonly defaults: string | null;
}

/** In aanmaakvolgorde, zodat het bord van links naar rechts leest zoals je het scant. */
export const SIGNAL_COLUMN_SPECS: readonly SignalColumnSpec[] = [
  { id: SIGNAL_COLUMNS.tijdstip, title: 'Tijdstip', type: 'date', defaults: null },
  {
    id: SIGNAL_COLUMNS.soort,
    title: 'Soort',
    type: 'status',
    defaults: JSON.stringify({ labels: SOORT_LABELS }),
  },
  { id: SIGNAL_COLUMNS.onderdeel, title: 'Onderdeel', type: 'text', defaults: null },
  { id: SIGNAL_COLUMNS.detail, title: 'Detail', type: 'long_text', defaults: null },
  { id: SIGNAL_COLUMNS.afgehandeld, title: 'Afgehandeld', type: 'checkbox', defaults: null },
  /**
   * NIET in het datamodel uit `docs/build/02-datamodel-monday.md`, en toch onmisbaar.
   *
   * Dit is waar een melding zichzelf aan herkent tussen twee runs. Zonder deze kolom zou de
   * controle op de ITEMNAAM moeten matchen — en die bevat het aantal trainingen, dus hij
   * verandert zodra er één training bijkomt. Elke ochtend een nieuwe rij voor hetzelfde
   * probleem, en afvinken zou niets betekenen.
   *
   * Bewust een gewone tekstkolom en niet verborgen: als iemand hem leegmaakt komt de melding
   * één keer terug, en dat is een begrijpelijk gevolg. Verbergen zou het onvindbaar maken
   * waaróm dat gebeurde.
   */
  { id: SIGNAL_COLUMNS.sleutel, title: 'Sleutel', type: 'text', defaults: null },
  {
    id: SIGNAL_COLUMNS.afgehandeldDoor,
    title: 'Afgehandeld door',
    type: 'text',
    defaults: null,
  },
];
