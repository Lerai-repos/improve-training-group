import { BRIEFING_AGENDA_COLUMNS, DUURCATEGORIE_CYCLUS } from '@lib/briefing/columns';

import { AGENDA_LABELS, OPPORTUNITY_LABELS } from './columns';

const C = BRIEFING_AGENDA_COLUMNS;

/** Wat er op de agenda staat: `null` is een lege cel. */
export interface AgendaStand {
  readonly voorbereidend: number | null;
  readonly huiswerk: number | null;
  /** De gezette label-ids van `DuurcategorieAG`. */
  readonly duurcategorie: readonly number[];
  /** Welke doelkolommen dit bord heeft; Agenda 2025 mist `Huisw. opdr.`. */
  readonly kolommen: ReadonlySet<string>;
}

/** De drie antwoorden op de Opportunity, als label-index; `null` is niet beantwoord. */
export interface OpportunityStand {
  readonly voorbereidend: number | null;
  readonly huiswerk: number | null;
  readonly cyclus: number | null;
}

export type OvernameVeld = 'voorbereidend' | 'huiswerk' | 'cyclus';

/** Opportunity en agenda zeggen iets anders. Er wordt dan niets geschreven; een mens kijkt. */
export interface Conflict {
  readonly veld: OvernameVeld;
  readonly opportunity: string;
  readonly agenda: string;
}

/** Kolomwaarden voor `change_multiple_column_values`, alleen voor de cellen die leeg waren. */
export type Kolomwaarden = Readonly<Record<string, { index: number } | { ids: number[] }>>;

export interface Overname {
  readonly schrijf: Kolomwaarden;
  readonly conflicten: readonly Conflict[];
}

/** Een ja/nee-kolom lezen op index; een index die geen van beide is telt als onbeantwoord. */
function jaNee(index: number | null, wel: readonly number[], geen: number): boolean | null {
  if (index === null) {
    return null;
  }
  if (wel.includes(index)) {
    return true;
  }
  return index === geen ? false : null;
}

/** Ja, nee, of onbeantwoord (leeg of het naamloze label). */
function cyclusOpOpportunity(index: number | null): boolean | null {
  if (index === null || index === OPPORTUNITY_LABELS.cyclus.leeg) {
    return null;
  }
  return index !== OPPORTUNITY_LABELS.cyclus.nee;
}

const woord = (ja: boolean): string => (ja ? 'Wel' : 'Geen');

/**
 * Wat er van de Opportunity naar deze training mag, en waar de twee elkaar tegenspreken.
 *
 * Dirkje, 17-Sep-2026: *"niet gespiegeld, maar overgenomen"* — voorvullen bij de conversie,
 * en de accountmanager kijkt daarna op de agenda of het nog klopt. Daarom **alleen lege
 * cellen**. Staat er al iets, dan is dat het oordeel van een mens: gelijk aan de Opportunity
 * is niets te doen, anders is het een conflict om te melden en niet om te beslechten.
 *
 * Een cyclus vult `DuurcategorieAG` alleen als die helemaal leeg is: staat er `workshop`, dan
 * weten wij niet of dat een vergissing is of een bewuste keuze. Staat het cycluslabel er al,
 * eventueel naast een ander label, dan is het gelijk.
 */
export function bepaalOvername(agenda: AgendaStand, opportunity: OpportunityStand): Overname {
  const schrijf: Record<string, { index: number } | { ids: number[] }> = {};
  const conflicten: Conflict[] = [];

  const jaNeeKolom = (
    veld: 'voorbereidend' | 'huiswerk',
    kolom: string,
    huidig: boolean | null,
    leeg: boolean,
    gewenst: boolean | null
  ): void => {
    if (gewenst === null || !agenda.kolommen.has(kolom)) {
      return;
    }
    if (leeg) {
      schrijf[kolom] = { index: gewenst ? AGENDA_LABELS[veld].wel : AGENDA_LABELS[veld].geen };
      return;
    }
    if (huidig !== null && huidig !== gewenst) {
      conflicten.push({ veld, opportunity: woord(gewenst), agenda: woord(huidig) });
    }
  };

  const vo = AGENDA_LABELS.voorbereidend;
  jaNeeKolom(
    'voorbereidend',
    C.voorbereidend,
    jaNee(agenda.voorbereidend, vo.welLijst, vo.geen),
    agenda.voorbereidend === null || agenda.voorbereidend === vo.onbeantwoord,
    jaNee(
      opportunity.voorbereidend,
      [OPPORTUNITY_LABELS.voorbereidend.wel],
      OPPORTUNITY_LABELS.voorbereidend.geen
    )
  );

  const ho = AGENDA_LABELS.huiswerk;
  jaNeeKolom(
    'huiswerk',
    C.huiswerk,
    jaNee(agenda.huiswerk, ho.welLijst, ho.geen),
    agenda.huiswerk === null,
    jaNee(opportunity.huiswerk, [OPPORTUNITY_LABELS.huiswerk.wel], OPPORTUNITY_LABELS.huiswerk.geen)
  );

  const cyclus = cyclusOpOpportunity(opportunity.cyclus);
  if (cyclus !== null && agenda.kolommen.has(C.duurcategorie)) {
    const heeftLabel = agenda.duurcategorie.includes(DUURCATEGORIE_CYCLUS);
    if (cyclus && agenda.duurcategorie.length === 0) {
      schrijf[C.duurcategorie] = { ids: [DUURCATEGORIE_CYCLUS] };
    } else if (cyclus && !heeftLabel) {
      conflicten.push({ veld: 'cyclus', opportunity: 'trainingscyclus', agenda: 'iets anders' });
    } else if (!cyclus && heeftLabel) {
      conflicten.push({ veld: 'cyclus', opportunity: 'Nee', agenda: 'trainingscyclus (2x4/2x7)' });
    }
  }

  return { schrijf, conflicten };
}
