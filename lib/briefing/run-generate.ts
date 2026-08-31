import {
  planBriefings,
  UnexpectedDestination,
  UnreviewedConflict,
  writeBriefings,
} from '@lib/sharepoint/publish';
import { yearOfDate } from '@lib/sharepoint/paths';

import { generateBriefings, plannedFilenames } from './generate';
import { planChangeReason, planFingerprint, trainingFingerprint } from './plan-token';
import { recordGeneration, recordInputFor } from './record';
import { buildTabView } from './tab';

import type { SavedChecklist } from './answers';
import type { ContextNote } from './context';
import type { GenerateContext, GeneratedDocument } from './generate';
import type { BriefingRecorder } from './record';
import type { BriefingTraining } from './types';
import type { SiteConfig } from '@lib/sharepoint/config';
import type { BriefingStore } from '@lib/sharepoint/store';

/**
 * De hele Genereren-stap, zonder HTTP en zonder tenant.
 *
 * Alles wat naar buiten praat komt hier als poort binnen, zodat de volgorde van beslissingen
 * — plannen, bevestigen, opnieuw controleren, schrijven, vastleggen — te testen is. De route
 * die hierboven zit vertaalt alleen nog uitkomsten naar statuscodes.
 *
 * Die scheiding is er niet uit netheid. Drie keer op rij bleek dat glue-code die alleen in
 * een route-handler bestaat niet te testen is: een Next-route mag niets anders exporteren dan
 * zijn HTTP-methoden, dus elke fout erin kwam pas aan het licht bij het lezen.
 */

export interface GenerateSnapshot {
  readonly saved: SavedChecklist | null;
  readonly token: string;
  readonly unreadable: boolean;
}

export interface RunGenerateDeps {
  /** De training van het agendabord. Wordt twee keer aangeroepen: vóór en ná het renderen. */
  readTraining(): Promise<BriefingTraining>;
  /** De opgeslagen antwoorden. Ook twee keer, om dezelfde reden. */
  readChecklist(): Promise<GenerateSnapshot>;
  readonly store: BriefingStore;
  readonly site: SiteConfig;
  buildContext(
    training: BriefingTraining,
    input: {
      actorItemIds: readonly string[];
      trainerItemIds: readonly string[];
    }
  ): Promise<{ context: GenerateContext; notes: readonly ContextNote[] }>;
  readonly recorder: BriefingRecorder;
  /** De Nederlandse kalenderdag, als `YYYY-MM-DD`. */
  today(): string;
  /** Hoeveel milliseconden er nog zijn om te schrijven én vast te leggen. */
  remainingMs(): number;
}

export interface RunGenerateInput {
  readonly itemId: string;
  readonly confirmExisting: boolean;
  readonly planToken?: string;
}

export interface PlanPayload {
  readonly stage: 'planned';
  readonly folderPath: string;
  readonly folderExists: boolean;
  readonly conflicts: readonly string[];
  readonly related: readonly string[];
  readonly filenames: readonly string[];
  readonly planToken: string;
  readonly changed?: 'input' | 'files';
}

export type RunGenerateOutcome =
  | { readonly kind: 'planned'; readonly plan: PlanPayload }
  /** Het plan is verschoven; de adviseur beslist opnieuw op basis van `plan`. */
  | { readonly kind: 'changed'; readonly plan: PlanPayload; readonly message: string }
  /** Er valt niets te genereren: de tab weet waarom en zegt het al. */
  | { readonly kind: 'blocked'; readonly message: string; readonly issues: readonly string[] }
  /** ITG's mappen zien er anders uit dan verwacht. Opnieuw proberen helpt niet. */
  | { readonly kind: 'refused'; readonly message: string }
  /** Te weinig tijd over om te schrijven én vast te leggen; er is niets aangeraakt. */
  | { readonly kind: 'no_time'; readonly message: string }
  | {
      readonly kind: 'written';
      readonly documents: readonly (Omit<GeneratedDocument, 'bytes' | 'filename'> & {
        readonly file: { readonly name: string; readonly webUrl: string };
        readonly versioned: boolean;
      })[];
      readonly notes: readonly ContextNote[];
      readonly administratie: readonly string[];
      readonly brie: string;
      readonly partial: boolean;
      readonly failure?: { readonly filename: string; readonly reason: string };
    };

/** Wat er minimaal over moet zijn vóórdat we aan het schrijven beginnen. */
export const UPLOAD_BUDGET_MS = 45_000;

export async function runGenerate(
  deps: RunGenerateDeps,
  input: RunGenerateInput
): Promise<RunGenerateOutcome> {
  const training = await deps.readTraining();
  const snapshot = await deps.readChecklist();

  /**
   * Onleesbare antwoorden blokkeren het genereren.
   *
   * De tab houdt het bewerken al tegen, maar deze weg is ook zonder tab te bereiken. Met een
   * leeg formulier verder gaan zou een briefing opleveren waarin elk vinkje uitstaat terwijl
   * er wél antwoorden waren — en niemand die het document leest ziet dat.
   */
  if (snapshot.unreadable) {
    return {
      kind: 'blocked',
      message:
        'Er staan antwoorden opgeslagen die niet te lezen zijn; vul de checklist opnieuw in.',
      issues: [],
    };
  }

  /**
   * Dezelfde beslissingen als het scherm, uit dezelfde functie: zou de knop ze hier opnieuw
   * uitschrijven, dan kan hij iets anders vinden dan het scherm ernaast toont.
   */
  const view = buildTabView(training, snapshot.saved);
  if (!view.kanGenereren) {
    return {
      kind: 'blocked',
      message: 'Deze briefing kan nog niet gegenereerd worden.',
      issues: view.issues.filter((issue) => issue.blokkeert).map((issue) => issue.tekst),
    };
  }

  const plek = {
    label: training.label,
    klant: training.opdrachtgever,
    jaar: yearOfDate(training.datum),
    filenames: plannedFilenames(training, view.checklist, view.actorItemIds),
  };

  const gepland = await planBriefings(deps.store, deps.site, plek);
  if (gepland.kind === 'refused') {
    return { kind: 'refused', message: gepland.reason };
  }

  const vingerafdruk = planFingerprint({
    folderPath: gepland.plan.folderPath,
    folderExists: gepland.plan.folderExists,
    filenames: plek.filenames,
    conflicts: gepland.plan.conflicts,
    checklistToken: snapshot.token,
  });
  const plan: PlanPayload = {
    stage: 'planned',
    folderPath: gepland.plan.folderPath,
    folderExists: gepland.plan.folderExists,
    conflicts: gepland.plan.conflicts,
    related: gepland.plan.related,
    filenames: plek.filenames,
    planToken: vingerafdruk,
  };

  if (!input.confirmExisting) {
    return { kind: 'planned', plan };
  }

  /**
   * Bevestigd — maar waarvoor precies? Komt het plan niet meer overeen met wat er getoond
   * is, dan gaat het schrijven niet door en beslist de adviseur opnieuw.
   */
  if (input.planToken !== vingerafdruk) {
    const reden = planChangeReason(input.planToken, vingerafdruk);
    return {
      kind: 'changed',
      plan: { ...plan, changed: reden },
      message:
        reden === 'input'
          ? 'De checklist is intussen gewijzigd. Het scherm wordt opnieuw geladen; controleer de antwoorden voordat je genereert.'
          : 'Er staan nu andere bestanden in de map dan toen je dit plan zag. Controleer het opnieuw.',
    };
  }

  const { context, notes } = await deps.buildContext(training, {
    actorItemIds: view.actorItemIds,
    trainerItemIds: view.documenten.map((doc) => doc.itemId),
  });

  const gemaakt = await generateBriefings(training, view.checklist, context);
  if (gemaakt.kind === 'refused') {
    return { kind: 'refused', message: gemaakt.reason };
  }

  /**
   * Opnieuw lezen vlak vóór het schrijven, want renderen kostte tijd — sjablonen, Google en
   * de LLM. Een collega kan in die seconden een antwoord wijzigen of de datum verzetten, en
   * dan hoort er geen document de deur uit te gaan dat bij niemands antwoorden past.
   */
  const verse = await deps.readChecklist();
  const verseTraining = await deps.readTraining();
  if (
    verse.token !== snapshot.token ||
    trainingFingerprint(verseTraining) !== trainingFingerprint(training)
  ) {
    return {
      kind: 'changed',
      plan: { ...plan, changed: 'input' },
      message:
        'De gegevens zijn gewijzigd terwijl de briefing werd gemaakt. Het scherm wordt opnieuw geladen; controleer het en probeer opnieuw.',
    };
  }

  /**
   * Genoeg tijd over om te schrijven én vast te leggen? Zo niet: nu stoppen. Er staat dan
   * niets in de klantmap, en dat is beter dan halverwege afgekapt worden met bestanden die
   * nergens zijn geregistreerd.
   */
  if (deps.remainingMs() < UPLOAD_BUDGET_MS) {
    return {
      kind: 'no_time',
      message:
        'Het samenstellen duurde te lang, dus er is niets weggeschreven. Probeer het opnieuw.',
    };
  }

  let geschreven;
  try {
    geschreven = await writeBriefings(
      deps.store,
      deps.site,
      plek,
      gemaakt.documents.map((doc) => ({ filename: doc.filename, bytes: doc.bytes })),
      {
        confirmedExisting: true,
        confirmedConflicts: gepland.plan.conflicts,
        confirmedFolderPath: gepland.plan.folderPath,
      }
    );
  } catch (error) {
    /**
     * Er is iets bijgekomen sinds de adviseur keek, of de bestemming is verschoven. Niets
     * geschreven, niets stuk — dus dezelfde uitkomst als een verschoven plan.
     */
    if (error instanceof UnreviewedConflict || error instanceof UnexpectedDestination) {
      const opnieuw = await planBriefings(deps.store, deps.site, plek);
      return {
        kind: 'changed',
        message: `${error.message}. Controleer het opnieuw.`,
        plan:
          opnieuw.kind === 'ok'
            ? {
                ...plan,
                folderPath: opnieuw.plan.folderPath,
                folderExists: opnieuw.plan.folderExists,
                conflicts: opnieuw.plan.conflicts,
                related: opnieuw.plan.related,
                changed: 'files',
                planToken: planFingerprint({
                  folderPath: opnieuw.plan.folderPath,
                  folderExists: opnieuw.plan.folderExists,
                  filenames: plek.filenames,
                  conflicts: opnieuw.plan.conflicts,
                  checklistToken: snapshot.token,
                }),
              }
            : { ...plan, changed: 'files' },
      };
    }
    throw error;
  }

  if (geschreven.kind === 'refused') {
    return { kind: 'refused', message: geschreven.reason };
  }
  if (geschreven.written.length > gemaakt.documents.length) {
    throw new Error(
      `Geschreven (${geschreven.written.length}) en gerenderde (${gemaakt.documents.length}) documenten lopen niet gelijk`
    );
  }

  const administratie = await recordGeneration(
    deps.recorder,
    recordInputFor({
      trainingItemId: input.itemId,
      documents: gemaakt.documents,
      written: geschreven.written,
      vandaag: deps.today(),
    })
  );

  return {
    kind: 'written',
    partial: geschreven.kind === 'partial',
    failure: geschreven.kind === 'partial' ? geschreven.failure : undefined,
    documents: geschreven.written.map((bestand, index) => ({
      trainerItemId: gemaakt.documents[index].trainerItemId,
      trainerNaam: gemaakt.documents[index].trainerNaam,
      role: gemaakt.documents[index].role,
      open: gemaakt.documents[index].open,
      file: bestand.file,
      versioned: bestand.versioned,
    })),
    notes,
    administratie: administratie.problemen,
    brie: administratie.brie,
  };
}
