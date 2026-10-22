import { labelSleutel, resolveLabelCode } from '@lib/labels';

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
 * volledige namen, dus beide wijzen naar hetzelfde label. Op nummer, zodat ITG deze negen mag
 * hernoemen.
 *
 * Elk ander nummer gaat op de tekst van het label, zie `labelVanOpportunity`: zo werkt een label
 * dat ITG later toevoegt (17 `ITG`) zonder dat het hier hoeft te staan. 5 (leeg),
 * 11 `ST - StressTrainer`, 14 `Email` en 15 `TMT` hebben geen rij op het Labels-bord en krijgen
 * dus geen link.
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

/** De opzoeksleutel van het label (`labelSleutel`), of `null` als de cel leeg is. */
export function labelVanOpportunity(
  labelIndex: number | null,
  labelTekst: string
): LabelCode | null {
  if (labelIndex === null) {
    return null;
  }
  /** Ook het vaste nummer door de sleutel: 8 is `FT`, en dat heet nu "Feedback Trainer". */
  const vast = OPPORTUNITY_LABEL[labelIndex];
  return vast === undefined ? resolveLabelCode(labelTekst) : labelSleutel(vast);
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
  /** De tekst van dat label; telt alleen voor een nummer dat niet in `OPPORTUNITY_LABEL` staat. */
  readonly labelTekst: string;
}

/** De link die er hoort te staan, of `null` als er geen hoort te staan. */
export function gewensteLink(
  opportunity: OpportunityLabel,
  /** Op de sleutel van het label, zie `leesWebsites`. */
  websites: ReadonlyMap<LabelCode, string>
): string | null {
  const label = labelVanOpportunity(opportunity.labelIndex, opportunity.labelTekst);
  const website = label === null ? undefined : websites.get(label);
  return website === undefined ? null : inventarisatieLink(website, opportunity.itemId);
}
