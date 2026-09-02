import { fetchArtwork } from './assets';
import { chartColours } from './colours';
import { buildReportModel } from './model';
import { renderReportHtml } from './template';

import type { ReportInput } from './types';

/**
 * Van één training naar één PDF. De laatste schakel; alles ervóór is lezen.
 */

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

export interface GeneratedReport {
  readonly pdf: Uint8Array;
  readonly html: string;
  /** Afbeeldingen die niet opgehaald konden worden. Het rapport is er zonder ook. */
  readonly warnings: readonly string[];
  readonly responseCount: number;
  /**
   * Het gemiddelde eindcijfer zoals het in het rapport staat, of `null`.
   *
   * Meegegeven en niet elders herberekend: dit getal gaat ook naar het agendabord, en twee
   * berekeningen van hetzelfde cijfer zijn twee kansen om te gaan afwijken van wat de klant
   * in het document ziet staan.
   */
  readonly gemiddeldeBeoordeling: string | null;
}

export type ReportOutcome =
  | { readonly kind: 'ok'; readonly report: GeneratedReport }
  /**
   * Geen enkele respons op de code van deze training.
   *
   * GEEN fout, en met opzet geen leeg rapport: dit is de "geen data"-situatie die ITG in
   * februari aanvroeg en die nooit gebouwd is. Er hoort dan een statuswijziging en een
   * andere mail te volgen, niet een document met nul overal. De aanroeper beslist; deze
   * functie weigert alleen te doen alsof.
   */
  | { readonly kind: 'no_responses' };

export async function generateReport(
  input: ReportInput,
  renderer: PdfRenderer
): Promise<ReportOutcome> {
  if (input.responses.length === 0) {
    return { kind: 'no_responses' };
  }

  /**
   * De afbeeldingen eerst, en de mislukkingen als waarschuwing meenemen.
   *
   * Een ontbrekend logo mag geen rapport tegenhouden — het document is zonder nog steeds
   * bruikbaar — maar het mag ook niet ongemerkt gebeuren, want dan verstuurt ITG een
   * ongebrand rapport zonder te weten dat er iets miste.
   */
  const artwork = await fetchArtwork(input.label);
  const model = buildReportModel(input);
  const html = renderReportHtml(model, artwork, chartColours(input.label.kleur));
  const pdf = await renderer.render(html);

  return {
    kind: 'ok',
    report: {
      pdf,
      html,
      warnings: artwork.problems,
      responseCount: input.responses.length,
      gemiddeldeBeoordeling: model.gemiddeldeBeoordeling,
    },
  };
}
