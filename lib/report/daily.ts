import { attributeResponses } from '@lib/evaluations';

import { evalWriteFor } from './record';

import type { EvaluationResponse, TrainingRef } from '@lib/evaluations';
import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { EvalResult } from './record';
import type { TrainingForReport } from './training';

/**
 * De dagelijkse verwerking: trainingen van gisteren, uitkomst bepalen, bord bijwerken.
 *
 * **Er wordt hier geen PDF gemaakt.** Zolang de mailbox er niet is heeft een rapport nergens
 * heen te gaan — `04-evaluatierapportage.md`: de mail ís de aflevering, het bestand wordt
 * nergens bewaard. Wat wél elke dag moet gebeuren is het bord bijwerken, en vooral het
 * signaal bij een training zonder reacties: dat staat als deliverable in de ondertekende
 * scope (*"Evaluatie na afloop met signaal bij ontbrekende respons"*) en is in februari
 * gevraagd maar nooit gebouwd. Het rapport zelf is tot die tijd opvraagbaar via de route.
 *
 * Alles is ingespoten, zodat de hele dagjob getest kan worden zonder Monday of Google.
 */

/** Eén training zoals de agendalezer hem oplevert: genoeg om te filteren en toe te kennen. */
export interface DailyAgendaTraining {
  readonly trainingItemId: string;
  /** `YYYY-MM-DD`, of null wanneer er geen datum staat. */
  readonly datum: string | null;
  readonly boardId: string;
  readonly ref: TrainingRef;
}

export interface DailyDeps {
  /** Alle trainingen over alle jaargangen — de toekenning heeft ze allemaal nodig. */
  readAgenda: () => Promise<readonly DailyAgendaTraining[]>;
  readTraining: (itemId: string) => Promise<TrainingForReport | null>;
  readLabels: () => Promise<ReadonlyMap<LabelCode, LabelRecord>>;
  readResponses: () => Promise<readonly EvaluationResponse[]>;
  writeColumns: (itemId: string, values: Record<string, unknown>) => Promise<void>;
}

export interface DailyOptions {
  /** De dag die verwerkt wordt, `YYYY-MM-DD`. De aanroeper bepaalt hem, niet dit bestand. */
  readonly date: string;
  /** Alleen trainingen van dit bord. De lopende jaargang; oudere jaargangen zijn historie. */
  readonly boardId: string;
  readonly dryRun: boolean;
}

export interface DailyLine {
  readonly itemId: string;
  readonly klanttitel: string;
  readonly result: EvalResult['kind'];
  readonly summary: string;
  readonly wrote: boolean;
}

export interface DailyReport {
  readonly date: string;
  readonly considered: number;
  readonly written: number;
  readonly dryRun: boolean;
  readonly lines: readonly DailyLine[];
  readonly totals: Readonly<Record<EvalResult['kind'], number>>;
}

/**
 * De kalenderdag vóór `iso`, als `YYYY-MM-DD`.
 *
 * Op de DATUM rekenen en niet 24 uur van een tijdstip aftrekken. Bij de overgang naar
 * zomertijd duurt de dag 23 uur en bij die naar wintertijd 25 — 24 uur aftrekken landt dan
 * op dezelfde dag of slaat er een over, en de dagjob zou de trainingen van die dag dubbel
 * of helemaal niet verwerken. Twee keer per jaar, en precies dan let niemand op.
 *
 * `Date.UTC` mag hier wél: er zit geen tijd in de waarde, alleen een kalenderdatum.
 */
export function previousDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/**
 * Het uur in Amsterdam, als getal.
 *
 * Via `Intl` en niet via een offsetberekening, om dezelfde reden als `amsterdamToday`: de
 * zone kent zomertijd en een handmatige `+1` of `+2` heeft twee keer per jaar ongelijk.
 */
export function amsterdamHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      hour: '2-digit',
      hour12: false,
    }).format(now)
  );
}

/** Het uur waarop de dagverwerking hoort te draaien — hetzelfde moment als legacy Flow 9. */
export const DAILY_HOUR_AMSTERDAM = 6;

/**
 * Draait deze aanroep op het juiste moment?
 *
 * Vercel leest cron-expressies **altijd in UTC**, en Amsterdam schuift met de zomertijd. Eén
 * expressie is dus vijf maanden per jaar een uur mis. De oplossing is twee cron-regels —
 * `30 4` en `30 5` UTC — waarvan er het hele jaar door precies één op 06:30 Amsterdam
 * uitkomt; deze grendel laat de andere niets doen.
 *
 * Dat de exacte tijd inhoudelijk weinig uitmaakt (de job leest álle reacties en matcht op
 * code) doet er niet aan af: de route belóóft 06:30 en gelijkloop met legacy, en code die
 * iets anders doet dan ze zegt is een fout, ook als de gevolgen klein zijn.
 */
export function shouldRunNow(now: Date): boolean {
  return amsterdamHour(now) === DAILY_HOUR_AMSTERDAM;
}

const EMPTY_TOTALS: Record<EvalResult['kind'], number> = {
  ok: 0,
  no_responses: 0,
  no_code: 0,
  unknown_label: 0,
  missing_trainer: 0,
  ambiguous_code: 0,
  not_found: 0,
};

/**
 * Beslis wat er van één training waar is, zonder iets te renderen.
 *
 * Spiegelt bewust de volgorde van `runReport`: eerst het label, dan de code, dan de
 * reacties. Een training zonder code krijgt géén `Onvindbaar` — er is nooit een evaluatie
 * uitgezet, dus die status zou een zoekactie suggereren die niet heeft plaatsgevonden.
 */
export function classify(
  training: TrainingForReport,
  label: LabelRecord | undefined,
  responses: readonly EvaluationResponse[],
  /** Trainingen waarvan de code door meerdere klanten geclaimd wordt. */
  ambiguous: ReadonlySet<string>
): EvalResult {
  if (training.labelCode === null || label === undefined) {
    return { kind: 'unknown_label' };
  }
  if (training.trainerNamen.length === 0) {
    return { kind: 'missing_trainer' };
  }
  if (training.rawIeCode === null) {
    return { kind: 'no_code' };
  }
  /**
   * Dubbelzinnigheid VÓÓR de lege-lijst-check.
   *
   * Bij een botsende code houdt `attributeResponses` de reacties bewust tegen, dus de lijst
   * is leeg terwijl de reacties bestaan. Dat als `no_responses` afdoen zet `Onvindbaar` en
   * nul respondenten op het bord — een bewering die niet klopt, en die ITG naar de verkeerde
   * oplossing stuurt: achter deelnemers aan in plaats van de dubbele code herstellen.
   */
  if (ambiguous.has(training.itemId)) {
    return { kind: 'ambiguous_code' };
  }
  if (responses.length === 0) {
    return { kind: 'no_responses' };
  }
  const grades = responses
    .map((r) => r.grade)
    .filter((g): g is number => g !== null && Number.isFinite(g));
  const gemiddelde =
    grades.length === 0 ? null : (grades.reduce((sum, g) => sum + g, 0) / grades.length).toFixed(1);
  return { kind: 'ok', responseCount: responses.length, gemiddelde };
}

export async function runDailyReports(
  deps: DailyDeps,
  options: DailyOptions
): Promise<DailyReport> {
  const agenda = await deps.readAgenda();

  /**
   * Filteren op datum ÉN bord.
   *
   * Zonder de bordcheck zou een oude jaargang met dezelfde datum meelopen; die trainingen
   * zijn historie en hun status hoort niet meer te bewegen.
   */
  const today = agenda.filter((t) => t.datum === options.date && t.boardId === options.boardId);

  if (today.length === 0) {
    return {
      date: options.date,
      considered: 0,
      written: 0,
      dryRun: options.dryRun,
      lines: [],
      totals: { ...EMPTY_TOTALS },
    };
  }

  /**
   * Responses en labels ÉÉN keer, voor de hele dag.
   *
   * Dit is de reden dat de dagjob de route niet over HTTP aanroept: die leest drie
   * Google-documenten per training. Bij vijftien trainingen is dat vijftien keer 3.700
   * reacties ophalen voor precies dezelfde uitkomst.
   */
  const [responses, labels] = await Promise.all([deps.readResponses(), deps.readLabels()]);

  /**
   * Toekennen over de HELE agenda, niet alleen de dag van vandaag.
   *
   * Een code die gedeeld wordt met een training van een andere dag moet nog steeds als
   * gedeeld herkend worden; alleen naar vandaag kijken zou van zo'n code een botsing maken.
   */
  const attribution = attributeResponses(
    responses,
    agenda.map((t) => t.ref)
  );

  const ambiguous = new Set(attribution.report.trainingsWithAmbiguousCode);

  const lines: DailyLine[] = [];
  const totals = { ...EMPTY_TOTALS };
  let written = 0;

  for (const item of today) {
    const training = await deps.readTraining(item.trainingItemId);
    if (training === null) {
      totals.not_found += 1;
      lines.push({
        itemId: item.trainingItemId,
        klanttitel: '(niet gevonden)',
        result: 'not_found',
        summary: 'item verdween tussen het lezen van de agenda en nu',
        wrote: false,
      });
      continue;
    }

    const label = training.labelCode === null ? undefined : labels.get(training.labelCode);
    const result = classify(
      training,
      label,
      attribution.responsesByTraining.get(item.trainingItemId) ?? [],
      ambiguous
    );
    const write = evalWriteFor(result, { ieStatus: training.ieStatus });
    const heeftWaarden = Object.keys(write.values).length > 0;

    if (heeftWaarden && !options.dryRun) {
      await deps.writeColumns(item.trainingItemId, write.values);
      written += 1;
    }

    totals[result.kind] += 1;
    lines.push({
      itemId: item.trainingItemId,
      klanttitel: training.klanttitel,
      result: result.kind,
      summary: write.summary,
      wrote: heeftWaarden && !options.dryRun,
    });
  }

  return {
    date: options.date,
    considered: today.length,
    written,
    dryRun: options.dryRun,
    lines,
    totals,
  };
}
