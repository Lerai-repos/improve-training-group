import { attributeResponses } from '@lib/evaluations';
import {
  buildMailFacts,
  composeMails,
  describeError,
  isRedirected,
  sendWithRetry,
} from '@lib/mail';

import { generateReport } from './generate';
import { evalWriteFor } from './record';

import type { EvaluationResponse, TrainingRef } from '@lib/evaluations';
import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { FailureStore, MailRecipients, MailSender, MailVariant, SentGuard } from '@lib/mail';
import type { PdfRenderer } from './generate';
import type { EvalResult } from './record';
import type { TrainingForReport } from './training';

/**
 * De dagelijkse verwerking: trainingen van gisteren, uitkomst bepalen, bord bijwerken, en de
 * twee mails per training de deur uit.
 *
 * **Hier wordt sinds 4-Sep-2026 wél een PDF gemaakt**, en alleen voor de trainingen die er
 * een nodig hebben. De eerdere keuze om dat niet te doen had één reden — er was geen postvak,
 * dus een rapport had nergens heen te gaan en het bestand wordt nergens bewaard. Dat postvak
 * is er nu (`automatisering@improvetraininggroup.nl`), dus die reden is vervallen. Een sessie
 * zonder reacties rendert nog steeds niets: de ZONDER-varianten hebben geen bijlage.
 *
 * Wat er per training gebeurt hangt aan de uitkomst, en aan niets anders:
 *
 * | uitkomst | bord | mails |
 * |---|---|---|
 * | `ok` | cijfer + respondenten + status | de twee MET-varianten, met het rapport erbij |
 * | `no_responses` | status `Onvindbaar` | de twee ZONDER-varianten, zonder bijlage |
 * | de overige vier | niets | niets |
 *
 * Die laatste regel loopt gelijk met `evalWriteFor`: zonder code is er nooit een evaluatie
 * uitgezet, bij een onbekend label ligt het probleem in de configuratie, en bij een dubbele
 * code bestaan de reacties wél. In alle drie de gevallen zou een mail aan de accountmanager
 * iets beweren wat niet waar is. Ze worden gemeld op het Systeem-bord, niet per mail.
 *
 * Alles is ingespoten, zodat de hele dagjob getest kan worden zonder Monday, Google, Chromium
 * of Exchange.
 */

/** Eén training zoals de agendalezer hem oplevert: genoeg om te filteren en toe te kennen. */
export interface DailyAgendaTraining {
  readonly trainingItemId: string;
  /** `YYYY-MM-DD`, of null wanneer er geen datum staat. */
  readonly datum: string | null;
  readonly boardId: string;
  /**
   * Staat het bord actief in Monday? Alleen die trainingen worden verwerkt. Een gearchiveerd
   * jaar is historie: het telt mee voor de toekenning, maar zijn statussen bewegen niet meer.
   */
  readonly live: boolean;
  readonly ref: TrainingRef;
}

/**
 * Alles wat er nodig is om te mailen, apart gehouden van het lezen en schrijven.
 *
 * Eén blok en geen losse velden, zodat een aanroeper die niet mailt (een test over alleen de
 * bordkant) hem in zijn geheel weglaat in plaats van vijf stubs te moeten verzinnen.
 */
export interface DailyMailDeps {
  readonly sender: MailSender;
  readonly recipients: MailRecipients;
  readonly guard: SentGuard;
  /**
   * Waar een mislukte verzending wordt achtergelaten.
   *
   * Niet om er hier iets mee te doen, maar zodat de dagelijkse controle hem 's ochtends op het
   * Systeem-bord kan zetten. Een mislukte mail komt namelijk NIET vanzelf goed: de dagjob
   * kijkt alleen naar de dag ervoor, dus zonder melding blijft hij liggen tot iemand toevallig
   * in een log kijkt.
   */
  readonly failures: FailureStore;
  readonly renderer: PdfRenderer;
  /** De e-mailadressen van de trainers, op itemnummer van het trainersbord. */
  readTrainerEmails: (itemIds: readonly string[]) => Promise<readonly string[]>;
  nowMs: () => number;
}

export interface DailyDeps {
  /** Alle trainingen over alle jaargangen — de toekenning heeft ze allemaal nodig. */
  readAgenda: () => Promise<readonly DailyAgendaTraining[]>;
  readTraining: (itemId: string) => Promise<TrainingForReport | null>;
  readLabels: () => Promise<ReadonlyMap<LabelCode, LabelRecord>>;
  readResponses: () => Promise<readonly EvaluationResponse[]>;
  /** Op het bord van de training zelf: een 2027-item schrijven met het id van 2026 mislukt. */
  writeColumns: (itemId: string, boardId: string, values: Record<string, unknown>) => Promise<void>;
  /**
   * Weglaten betekent: niet mailen.
   *
   * Bewust weglaatbaar en niet een vlag ernaast. Een `sendMail: false` naast een volledig
   * aangesloten verzender laat de mogelijkheid open dat de vlag ergens omgezet wordt zonder
   * dat iemand het merkt; een ontbrekend blok kán niet per ongeluk gaan verzenden.
   */
  readonly mail?: DailyMailDeps;
}

export interface DailyOptions {
  /** De dag die verwerkt wordt, `YYYY-MM-DD`. De aanroeper bepaalt hem, niet dit bestand. */
  readonly date: string;
  readonly dryRun: boolean;
}

export interface DailyLine {
  readonly itemId: string;
  readonly klanttitel: string;
  readonly result: EvalResult['kind'];
  readonly summary: string;
  readonly wrote: boolean;
  /** Hoeveel mails er daadwerkelijk weg zijn. Bij een droogloop altijd 0. */
  readonly mailed: number;
  /** Wat er met de mails gebeurde, in één regel; leeg als er niets te melden was. */
  readonly mailNote: string;
  /**
   * Afbeeldingen die het rapport niet kon ophalen.
   *
   * Het rapport is er zonder ook, maar dan is het ongebrand — en dat mag niet onzichtbaar
   * blijven in een keten die het document meteen daarna verstuurt en de levering duurzaam
   * afvinkt.
   */
  readonly warnings: readonly string[];
}

export interface DailyReport {
  readonly date: string;
  readonly considered: number;
  readonly written: number;
  readonly dryRun: boolean;
  readonly lines: readonly DailyLine[];
  readonly totals: Readonly<Record<EvalResult['kind'], number>>;
  /** Verstuurde mails over de hele dag. */
  readonly mailed: number;
  /** Trainingen waarvan het mailen mislukte; de bordkant is dan wél bijgewerkt. */
  readonly mailFailures: readonly string[];
  /**
   * Waar de mails naartoe gingen, en of dat de echte postbussen waren.
   *
   * Staat er in de uitkomst omdat een vergeten `ITG_MAIL_KLANT` in productie anders volkomen
   * geslaagd oogt: elke run meldt succes terwijl elk rapport naar een testadres gaat. Een
   * omleiding hoort niet stilletjes te kunnen blijven staan.
   */
  readonly delivery: {
    readonly klant: string;
    readonly trainer: string;
    readonly redirected: boolean;
  } | null;
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

interface MailAttempt {
  readonly mailed: number;
  readonly note: string;
  readonly failed: boolean;
  /** Afbeeldingen die het rapport niet kon ophalen. Zie `DailyLine.warnings`. */
  readonly warnings: readonly string[];
}

const NIETS: MailAttempt = { mailed: 0, note: '', failed: false, warnings: [] };

/**
 * De twee mails voor één training, met de grendel eromheen.
 *
 * De grendel wordt **vóór** het renderen geclaimd en niet erna. Renderen kost een
 * Chromium-start van een paar seconden; twee runs die elkaar overlappen zouden anders
 * allebei renderen en pas daarna ontdekken dat er maar één mag versturen.
 */
async function mailForTraining(
  mail: DailyMailDeps,
  training: TrainingForReport,
  label: LabelRecord,
  responses: readonly EvaluationResponse[],
  variant: MailVariant,
  dryRun: boolean
): Promise<MailAttempt> {
  if (dryRun) {
    return {
      mailed: 0,
      note: `zou de twee ${variant}-mails sturen`,
      failed: false,
      warnings: [],
    };
  }

  const claim = await mail.guard.claim(training.itemId, variant, mail.nowMs());
  if (claim.kind === 'bezet') {
    if (claim.reden === 'bezig') {
      return {
        mailed: 0,
        note: `${variant}-mails: een andere run is er mee bezig`,
        failed: false,
        warnings: [],
      };
    }
    /**
     * Aantoonbaar verstuurd, dus een melding hierover is achterstallig.
     *
     * Dit is de ENIGE plek waar zo'n blijven-hangen-melding nog opgeruimd kan worden. Lukte
     * het opruimen destijds niet — één hikje in KV volstaat — dan komt de verzendkant hier
     * nooit meer langs, want die stopt bij een bevestigde claim. Zonder deze regel blijft er
     * dus voorgoed "mail mislukt" op het Systeem-bord staan over een mail die gewoon is
     * aangekomen, en herstelt geen enkele herstelrun dat.
     */
    const opgeruimd = await mail.failures
      .clear(training.itemId, variant)
      .then(() => true)
      .catch(() => false);
    return {
      mailed: 0,
      note: `${variant}-mails al eerder verstuurd${opgeruimd ? '' : ' (oude melding bleef staan)'}`,
      failed: false,
      warnings: [],
    };
  }

  /**
   * BUITEN de `try`, zodat een mislukking bij de tweede mail de eerste niet wegpoetst.
   *
   * Stond hij erbinnen, dan meldde de dagregel `0 verstuurd` terwijl er één de deur uit was —
   * en juist dán is het getal belangrijk, want de herstelrun stuurt die eerste opnieuw.
   */
  let verstuurd = 0;

  try {
    const trainerEmails = await mail.readTrainerEmails(training.trainerItemIds);

    /**
     * Bij `met` komt het cijfer uit het RAPPORT, niet uit `classify`.
     *
     * Allebei rekenen ze hetzelfde gemiddelde uit, en juist daarom moet er één bron zijn: de
     * mail noemt een cijfer dat de klant een alinea verderop in de bijlage terugziet, en twee
     * berekeningen van hetzelfde getal zijn twee kansen om ooit uit elkaar te lopen.
     */
    const rapport =
      variant === 'met'
        ? await generateReport({ training, label, responses }, mail.renderer)
        : null;
    if (rapport !== null && rapport.kind === 'no_responses') {
      throw new Error(
        `Training ${training.itemId} gold als beoordeeld maar het rapport vond geen reacties.`
      );
    }

    const facts = buildMailFacts({
      datum: training.datum,
      klanttitel: training.klanttitel,
      themaNamen: training.themaNamen,
      labelNaam: label.volledigeNaam,
      rapportterm: label.rapportterm,
      evaluatieformulier: label.evaluatieformulier,
      contactPersoon: training.contactPersoon,
      trainerNamen: training.trainerNamen,
      trainerEmails,
      accountmanager: training.accountmanager,
      ieCode: training.rawIeCode ?? '',
      aantalRespondenten: responses.length,
      gemiddelde: rapport === null ? null : rapport.report.gemiddeldeBeoordeling,
      vervolgPercentage: rapport === null ? null : rapport.report.vervolgPercentage,
    });

    /**
     * Ontbrekende huisstijl tegenhouden zou erger zijn dan doorlaten.
     *
     * `generateReport` levert bewust een rapport zónder logo in plaats van te weigeren: het
     * document is dan nog steeds bruikbaar. Maar het mag niet ongemerkt gebeuren, want dan
     * stuurt ITG een ongebrand rapport naar een klant zonder te weten dat er iets miste. Tot
     * nu toe verdwenen die waarschuwingen hier; nu gaan ze mee naar de dagrapportage én naar
     * de kop van de mail zelf, want daar staat de enige lezer die er iets aan kan doen.
     */
    const warnings = rapport === null ? [] : rapport.report.warnings;

    const mails = composeMails({
      variant,
      facts,
      recipients: mail.recipients,
      rapport: rapport === null ? undefined : rapport.report.pdf,
      warnings,
    });

    const pogingen: string[] = [];
    for (const composed of mails) {
      await sendWithRetry(mail.sender, composed.mail, {
        onRetry: (poging, fout) => {
          pogingen.push(`poging ${poging} (${composed.doel}): ${fout}`);
        },
      });
      verstuurd += 1;
    }

    /**
     * Pas nu wordt de korte claim een duurzame markering.
     *
     * Tot dit punt vervalt de claim vanzelf binnen een kwartier. Dat is wat een afgekapte run
     * — Vercel dat de functie beëindigt, een deploy er middendoor — laat herstellen in plaats
     * van een half jaar als verstuurd te gelden zonder ooit verstuurd te zijn.
     */
    /**
     * EERST de claim duurzaam maken, pas daarna de bijzaken opruimen.
     *
     * De mails zijn hier al weg. Struikelde het opruimen van de mislukkingsmelding daarvóór —
     * één hikje in KV is genoeg — dan viel de hele poging in het `catch`, werd de claim
     * teruggegeven en de verzending als mislukt geboekt. Een herstelrun stuurde dan allebei de
     * mails nóg een keer, om een boekhoudkundige storing, terwijl er niets mis was met de
     * verzending zelf.
     */
    const eigendom = await mail.guard.confirm(training.itemId, variant, claim.token, mail.nowMs());
    /**
     * De claim kan verlopen zijn terwijl deze verzending liep, en dan is hij van een andere
     * run. Die niet overschrijven — maar het wél melden, want dan staat er een mail in de
     * postbus die als "nog te doen" geboekt blijft en dus een tweede keer kan komen.
     */
    /**
     * Het opruimen van een eerdere melding mag niets meer omgooien.
     *
     * De verzending is geslaagd en vastgelegd; lukt dit niet, dan blijft er hooguit een melding
     * op het Systeem-bord staan die de volgende run alsnog weghaalt. Dat is oneindig veel
     * beter dan hier alsnog "mislukt" concluderen over twee mails die gewoon zijn aangekomen.
     */
    const opruimen = await mail.failures
      .clear(training.itemId, variant)
      .then(() => '')
      .catch(() => ' (oude melding bleef staan)');

    const kwijt = eigendom === 'verloren' ? ' (claim verlopen; kan dubbel komen)' : '';
    /**
     * Een geslaagde herhaling blijft zichtbaar.
     *
     * Anders verdwijnt een netwerk dat er twee keer per week uit ligt achter een run die
     * "gelukt" meldt, en merkt niemand het tot het een keer níét overwaait.
     */
    const herhaald = pogingen.length === 0 ? '' : ` na ${pogingen.length}x opnieuw`;
    return {
      mailed: verstuurd,
      note: `${verstuurd} ${variant}-mails verstuurd${herhaald}${kwijt}${opruimen}`,
      failed: false,
      warnings,
    };
  } catch (error) {
    /**
     * De claim teruggeven, zodat een herstelrun het opnieuw mag proberen.
     *
     * Kan de eerste mail al weg zijn en de tweede niet? Ja. Dan levert een herstelrun een
     * dubbele aftersalesmail op in ITG's eigen postbus. Dat is zichtbaar en te herstellen;
     * een mail die nooit meer verstuurd wordt omdat de claim bleef staan, is dat niet.
     *
     * Mét het token, zodat een verlopen claim die inmiddels van een andere run is niet
     * onder die run vandaan wordt weggegooid.
     */
    await mail.guard.release(training.itemId, variant, claim.token);
    const reden = describeError(error);
    await mail.failures.record({
      itemId: training.itemId,
      variant,
      klanttitel: training.klanttitel,
      datum: training.datum ?? '(geen datum)',
      reden,
      atMs: mail.nowMs(),
    });
    const deels = verstuurd === 0 ? '' : ` (${verstuurd} van de ${MAILS_PER_TRAINING} was al weg)`;
    return {
      mailed: verstuurd,
      note: `mailen mislukt: ${reden}${deels}`,
      failed: true,
      warnings: [],
    };
  }
}

/** Waar deze run naartoe stuurt, of `null` als er niet gemaild wordt. */
function deliveryOf(mail: DailyMailDeps | undefined): DailyReport['delivery'] {
  if (mail === undefined) {
    return null;
  }
  return {
    klant: mail.recipients.klant,
    trainer: mail.recipients.trainer,
    redirected: isRedirected(mail.recipients),
  };
}

/** Per training gaan er twee weg: één naar de accountmanagers, één naar backoffice. */
const MAILS_PER_TRAINING = 2;

/** Welke variant hoort bij deze uitkomst, of geen enkele. */
function variantFor(kind: EvalResult['kind']): MailVariant | null {
  if (kind === 'ok') {
    return 'met';
  }
  if (kind === 'no_responses') {
    return 'zonder';
  }
  return null;
}

export async function runDailyReports(
  deps: DailyDeps,
  options: DailyOptions
): Promise<DailyReport> {
  const agenda = await deps.readAgenda();

  /**
   * Filteren op datum ÉN op een actief bord.
   *
   * Elk actief agendabord doet mee, dus ook een nieuwe jaargang die ITG heeft gedupliceerd.
   * Een gearchiveerd jaar niet: dat is historie, en die statussen horen niet meer te bewegen.
   */
  const today = agenda.filter((t) => t.datum === options.date && t.live);

  if (today.length === 0) {
    return {
      date: options.date,
      considered: 0,
      written: 0,
      dryRun: options.dryRun,
      lines: [],
      totals: { ...EMPTY_TOTALS },
      mailed: 0,
      mailFailures: [],
      delivery: deliveryOf(deps.mail),
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
  const mailFailures: string[] = [];
  let written = 0;
  let mailed = 0;

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
        mailed: 0,
        mailNote: '',
        warnings: [],
      });
      continue;
    }

    const label = training.labelCode === null ? undefined : labels.get(training.labelCode);
    const mine = attribution.responsesByTraining.get(item.trainingItemId) ?? [];
    const result = classify(training, label, mine, ambiguous);
    const write = evalWriteFor(result, { ieStatus: training.ieStatus });
    const heeftWaarden = Object.keys(write.values).length > 0;

    if (heeftWaarden && !options.dryRun) {
      await deps.writeColumns(item.trainingItemId, item.boardId, write.values);
      written += 1;
    }

    /**
     * Mailen NA het bijwerken van het bord.
     *
     * Beide mails verwijzen naar de status in Monday — de ZONDER-varianten zeggen zelfs
     * letterlijk dat 'IE. Trainer' al op 'Onvindbaar' staat. Andersom zou die zin een tijd
     * lang onwaar zijn, en bij een mislukte bordschrijving blijvend.
     */
    const variant = variantFor(result.kind);
    const attempt =
      deps.mail === undefined || variant === null || label === undefined
        ? NIETS
        : await mailForTraining(deps.mail, training, label, mine, variant, options.dryRun);
    mailed += attempt.mailed;
    if (attempt.failed) {
      mailFailures.push(item.trainingItemId);
    }

    totals[result.kind] += 1;
    lines.push({
      itemId: item.trainingItemId,
      klanttitel: training.klanttitel,
      result: result.kind,
      summary: write.summary,
      wrote: heeftWaarden && !options.dryRun,
      mailed: attempt.mailed,
      mailNote: attempt.note,
      warnings: attempt.warnings,
    });
  }

  return {
    date: options.date,
    considered: today.length,
    written,
    dryRun: options.dryRun,
    lines,
    totals,
    mailed,
    mailFailures,
    delivery: deliveryOf(deps.mail),
  };
}
