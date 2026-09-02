import type { EvaluationResponse } from '@lib/evaluations/types';
import type { LabelRecord } from '@lib/labels/read';

/** Wat er van de training zelf in het rapport komt. */
export interface ReportTraining {
  /** Monday-item, alleen voor foutmeldingen en het registreren van het resultaat. */
  readonly itemId: string;
  /** "Building Boksing + Conflicthantering" — wat er in de aanhef staat. */
  readonly klanttitel: string;
  /** Ruwe inhoud van de contactpersoonkolom: "Lisa de Vries, Mark Jansen". */
  readonly contactPersoon: string;
  /** Volledige namen; het rapport gebruikt de voornamen. */
  readonly trainerNamen: readonly string[];
}

export interface ReportInput {
  readonly training: ReportTraining;
  readonly label: LabelRecord;
  /** Alle responses die aan deze training zijn toegekend. Mag leeg zijn. */
  readonly responses: readonly EvaluationResponse[];
}

/** Eén staafdiagram: de vraag, hoeveel antwoorden, het gemiddelde en de balken. */
export interface ChartModel {
  readonly question: string;
  /** "12 antwoorden, gemiddelde score: 4.3" — of zonder gemiddelde als niemand antwoordde. */
  readonly subtitle: string;
  readonly bars: ReadonlyArray<{ readonly pct: number; readonly label: string }>;
  /** De bijschriften onder de as: 1..5 of 1..10. */
  readonly axis: readonly string[];
}

export interface PieSlice {
  readonly label: string;
  readonly value: number;
  readonly colour: string;
}

/**
 * Alles wat de sjabloon nodig heeft, al uitgerekend.
 *
 * De sjabloon doet geen rekenwerk en neemt geen beslissingen — dat scheelt niet alleen
 * leesbaarheid maar maakt het rekenwerk ook toetsbaar zonder ooit HTML te vergelijken.
 *
 * **Alles hier is PLATTE TEKST, nooit HTML.** Namen, klanttitels en citaten komen uit Monday
 * en uit wat deelnemers intypen. Zou het model er markup omheen zetten, dan zou de sjabloon
 * niet meer kunnen ontsnappen zonder die markup ook te slopen — en dan gaat er vroeg of laat
 * een klanttitel met een `&` of een `<` doorheen. De sjabloon ontsnapt, en dus is dit tekst.
 */
export interface ReportModel {
  /** Voornamen van de contactpersonen, al samengevoegd. PLATTE TEKST. */
  readonly contactNamen: string;
  /** Voornamen van de trainers, al samengevoegd. PLATTE TEKST. */
  readonly trainerNamen: string;
  /** De titel zoals hij op de agenda staat. PLATTE TEKST. */
  readonly klanttitel: string;
  readonly rapportterm: string;
  readonly labelNaam: string;
  readonly trainerWoord: string;
  /** Het grote cijfer bovenaan; `null` als er geen enkel cijfer is ingevuld. */
  readonly gemiddeldeBeoordeling: string | null;
  readonly aantalRespondenten: number;
  readonly cijferChart: ChartModel;
  readonly trainingCharts: readonly ChartModel[];
  readonly trainerCharts: readonly ChartModel[];
  readonly followUp: {
    readonly subtitle: string;
    readonly slices: readonly PieSlice[];
    /** Kant-en-klare `conic-gradient(...)`; leeg als er niets te tonen valt. */
    readonly gradient: string;
  };
  readonly positieveCitaten: readonly string[];
  readonly verbeterCitaten: readonly string[];
}
