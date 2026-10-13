import type { LabelCode } from '@lib/labels';

/**
 * De link naar het inventarisatieformulier van één Opportunity.
 *
 * Elk label heeft een eigen website met een pagina `/inventarisatie`, waar ITG het generieke
 * formulier op zet. De website geeft `reference_id` door aan het veld "Referentie (niet
 * aanpassen)" van het formulier, en daarop vinden wij de antwoorden terug bij de briefing
 * (Blevin en Dirkje, 8-Oct-2026). De referentie is de Opportunity en niet het agenda-item: de
 * link gaat de deur uit vóór er een training is, en alle sessies van een cyclus delen hem.
 */

/**
 * De kolom `Label` op de Opportunity, op labelnummer (gemeten 12-Oct-2026). Hij mengt codes en
 * volledige namen, dus beide wijzen naar hetzelfde label. Op nummer, zodat ITG ze mag hernoemen.
 *
 * Niet hier, dus nooit een link: 5 (leeg), 11 `ST - StressTrainer`, 14 `Email`, 15 `TMT` en
 * 17 `ITG`. Die hebben geen eigen website op het Labels-bord.
 */
const OPPORTUNITY_LABEL: Readonly<Record<number, LabelCode>> = {
  0: 'TT',
  1: 'IT',
  2: 'WJ',
  3: 'FV',
  4: 'JE',
  6: 'SST',
  7: 'WJ',
  8: 'FT',
  9: 'IT',
  10: 'CC',
  12: 'CC',
  13: 'CP',
  16: 'CP',
};

export function labelVanOpportunity(labelIndex: number | null): LabelCode | null {
  return labelIndex === null ? null : (OPPORTUNITY_LABEL[labelIndex] ?? null);
}

/**
 * `https://www.workjoy.nl/inventarisatie?reference_id=…`, of `null` zonder bruikbare website.
 *
 * Alleen het domein van de website telt: een slash of pad erachter op het Labels-bord mag de
 * link niet breken. Een waarde die geen adres is levert geen link op in plaats van een kapotte.
 */
export function inventarisatieLink(website: string, opportunityId: string): string | null {
  let origin: string;
  try {
    origin = new URL(website.trim()).origin;
  } catch {
    return null;
  }
  return `${origin}/inventarisatie?reference_id=${encodeURIComponent(opportunityId)}`;
}

export interface OpportunityLabel {
  readonly itemId: string;
  /** Het labelnummer van `Label`, of `null` als de cel leeg is. */
  readonly labelIndex: number | null;
}

/** De link die er hoort te staan, of `null` als er geen hoort te staan. */
export function gewensteLink(
  opportunity: OpportunityLabel,
  websites: ReadonlyMap<LabelCode, string>
): string | null {
  const label = labelVanOpportunity(opportunity.labelIndex);
  const website = label === null ? undefined : websites.get(label);
  return website === undefined ? null : inventarisatieLink(website, opportunity.itemId);
}
