import { attributeResponses } from '@lib/evaluations';
import { describeError } from '@lib/mail';

import { classify, verwerkTraining } from './daily';

import type { DailyDeps, DailyLine } from './daily';
import type { KnopProbleemStore } from './knop-store';
import type { EvalResult } from './record';
import type { TrainingForReport } from './training';

/**
 * De knop **Eval Rapport** op het agendabord: één training opnieuw verwerken, op verzoek.
 *
 * Vervangt n8n's `Manual Evaluation Report`, die met n8n uit ging zonder dat er iets voor in
 * de plaats kwam. De bedrading in Monday blijft zoals hij was: de knop (`Eval Resend`) zet
 * `Eval Status` op `RUN`, en een webhook op die wijziging komt hier binnen.
 *
 * Wat er gebeurt is precies wat de dagjob met een training doet (`verwerkTraining`), met één
 * verschil: **de knop stuurt altijd**, ook als dezelfde mails al eens verstuurd zijn — zoals
 * in legacy. Alleen een verzending die op dat moment loopt houdt hem tegen.
 *
 * | uitkomst | bord | mails | Eval Status |
 * |---|---|---|---|
 * | reacties | cijfer + respondenten (+ `Onvindbaar` → `IE`) | twee MET, met rapport | leeg |
 * | geen reacties | `Onvindbaar` | twee ZONDER | leeg |
 * | geen IE-code | niets | niets | `Geen IE-code` (zoals legacy) |
 * | al het andere | niets | niets | `Zie Systeem-bord` + update + melding |
 *
 * "Al het andere" bestond in legacy niet als uitkomst: daar liep zo'n training stil vast. Nu
 * staat de reden meteen als update op de training (waar degene die drukte kijkt) en direct
 * daarna als melding op het Systeem-bord (`syncEvaluatieMeldingen` in de route), die vanzelf
 * verdwijnt zodra een volgende knopdruk wél lukt.
 */

/** `Eval Status` op het agendabord; bestaat sinds legacy. */
export const EVAL_STATUS_COLUMN = 'color_mm0v53mp';

/**
 * De labels van `Eval Status` op index, zodat ITG ze mag hernoemen.
 *
 * Gemeten op Agenda 2026 (12-Oct-2026): `{"0":"Geen IE-code","1":"RUN"}`.
 */
export const EVAL_STATUS_INDEX = { geenIeCode: 0, run: 1 } as const;

/**
 * Ons eigen label. Op naam geschreven met `create_labels_if_missing`, zodat Monday het
 * aanmaakt bij de eerste keer en er geen inrichtingsstap nodig is. Hernoemt ITG het, dan komt
 * er bij de volgende melding een nieuw label met deze naam bij: lelijk, maar er breekt niets.
 */
export const EVAL_STATUS_ZIE_SYSTEEMBORD = 'Zie Systeem-bord';

export type EvalStatusWaarde = 'leeg' | 'geen-ie-code' | 'zie-systeembord';

export type EvalKnopWebhook =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | {
      readonly kind: 'run';
      readonly itemId: string;
      readonly boardId: string;
      /** Om een dubbel afgeleverd event één keer te verwerken; ontbreekt soms. */
      readonly triggerUuid: string | null;
    }
  | { readonly kind: 'negeren'; readonly reden: string };

const KOLOMWIJZIGING = new Set([
  'update_column_value',
  'change_column_value',
  'change_status_column_value',
  'change_specific_column_value',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const alsId = (value: unknown): string | null =>
  typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

/**
 * Alleen `Eval Status` → `RUN` start iets.
 *
 * **De lusbeveiliging zit hier**: ons eigen leegmaken en het zetten van `Geen IE-code` of
 * `Zie Systeem-bord` zijn óók wijzigingen van deze kolom en komen óók als webhook binnen.
 */
export function parseEvalKnopWebhook(body: unknown): EvalKnopWebhook {
  if (!isRecord(body)) {
    return { kind: 'negeren', reden: 'geen object' };
  }
  if (typeof body.challenge === 'string') {
    return { kind: 'challenge', challenge: body.challenge };
  }
  const event = body.event;
  if (!isRecord(event) || typeof event.type !== 'string') {
    return { kind: 'negeren', reden: 'geen event' };
  }
  if (!KOLOMWIJZIGING.has(event.type)) {
    return { kind: 'negeren', reden: `event ${event.type}` };
  }
  if (event.columnId !== EVAL_STATUS_COLUMN) {
    return { kind: 'negeren', reden: 'andere kolom' };
  }
  const label = isRecord(event.value) && isRecord(event.value.label) ? event.value.label : null;
  if (label === null || label.index !== EVAL_STATUS_INDEX.run) {
    return { kind: 'negeren', reden: 'Eval Status is niet RUN' };
  }
  const itemId = alsId(event.pulseId);
  const boardId = alsId(event.boardId);
  if (itemId === null || boardId === null) {
    return { kind: 'negeren', reden: 'geen item of bord in het event' };
  }
  return {
    kind: 'run',
    itemId,
    boardId,
    triggerUuid: typeof event.triggerUuid === 'string' ? event.triggerUuid : null,
  };
}

export interface EvalKnopDeps
  extends Pick<
    DailyDeps,
    'readAgenda' | 'readTraining' | 'readLabels' | 'readResponses' | 'writeColumns' | 'mail'
  > {
  setEvalStatus: (itemId: string, boardId: string, waarde: EvalStatusWaarde) => Promise<void>;
  /** Een update op het item zelf: daar kijkt degene die op de knop drukte. */
  postUpdate: (itemId: string, tekst: string) => Promise<void>;
  readonly problemen: KnopProbleemStore;
  /** Vandaag in Amsterdam, `YYYY-MM-DD`. */
  vandaag: () => string;
  nowMs: () => number;
}

export interface EvalKnopUitkomst {
  /** Wat er op `Eval Status` is achtergebleven. */
  readonly status: EvalStatusWaarde;
  /** Wat de verwerking deed; ontbreekt als het niet zo ver kwam. */
  readonly line?: DailyLine;
  /** Waarom er geen rapport is, als dat zo is. */
  readonly reden?: string;
}

/** `2026-08-28` → `28-08-2026`, zoals ITG datums leest. */
const nlDatum = (iso: string | null): string =>
  iso === null ? '(geen datum)' : iso.split('-').reverse().join('-');

const codesIn = (raw: string | null): readonly string[] =>
  (raw ?? '').split(/[,\s]+/).filter((c) => c !== '');

/** De reden in mensentaal, voor de update en het Systeem-bord. */
/** Een training die dezelfde IE-code draagt, met wat de regel "één sessie" vergelijkt. */
interface Codegenoot {
  readonly itemId: string;
  readonly datum: string | null;
  readonly clientKey: string | null;
  readonly themaKey: string | null;
}

/**
 * Waarom een gedeelde code niet als één sessie telt, en wat ITG eraan doet.
 *
 * De regel is "zelfde Opportunity én zelfde Thema" (`attribute.ts`). De melding noemde eerst
 * altijd het bedrijf, ook als dat gelijk was en het Thema ontbrak (Dirkje, 16-Oct-2026, Total
 * Specific Solutions): dan zoekt iemand op de verkeerde plek.
 */
/** De twee kolommen die de regel vergelijkt, met hoe ITG ze in Monday ziet. */
const SESSIEKOLOMMEN = [
  { veld: 'clientKey', naam: 'Opportunity' },
  { veld: 'themaKey', naam: "Thema's" },
] as const;

function waaromGedeeld(groep: readonly Codegenoot[]): string {
  /**
   * ALLE redenen, niet de eerste: wie alleen het Thema invult terwijl ook de Opportunity
   * verschilt, drukt opnieuw op de knop en krijgt dan pas de tweede weigering.
   */
  const redenen = SESSIEKOLOMMEN.flatMap(({ veld, naam }) => {
    const leeg = groep.filter((g) => g[veld] === null).map((g) => `item ${g.itemId}`);
    const waarden = new Set(groep.flatMap((g) => (g[veld] === null ? [] : [g[veld]])));
    return [
      ...(leeg.length > 0 ? [`${naam} is leeg bij ${leeg.join(', ')}`] : []),
      ...(waarden.size > 1 ? [`${naam} verschilt tussen de trainingen`] : []),
    ];
  });
  return (
    "Is het één sessie, geef dan elke training dezelfde Opportunity én hetzelfde thema in de kolom " +
    "Thema's (de koppeling naar het Thema's-bord, niet de tekstkolom Thema)" +
    (redenen.length === 0 ? '.' : `. Nu: ${redenen.join('; ')}.`)
  );
}

function redenVoor(
  result: EvalResult,
  training: TrainingForReport,
  groep: readonly Codegenoot[]
): string {
  const anderen = groep.filter((g) => g.itemId !== training.itemId);
  switch (result.kind) {
    case 'unknown_label':
      return (
        `Het label "${training.rawLabel ?? ''}" heeft geen instellingen op het Labels-bord, ` +
        'dus er is geen huisstijl en geen evaluatieformulier om het rapport mee te maken.'
      );
    case 'missing_trainer':
      return 'Er is geen trainer gekoppeld aan deze training.';
    case 'ambiguous_code': {
      const lijst = anderen.map((a) => `item ${a.itemId}, ${nlDatum(a.datum)}`).join('; ');
      return (
        `IE-code ${training.rawIeCode ?? ''} staat ook op een andere training (${lijst}), ` +
        'en het is niet te zien bij welke sessie de reacties horen. Hoort de code daar niet, ' +
        `haal hem dan weg op de training waar hij niet hoort. ${waaromGedeeld(groep)}`
      );
    }
    default:
      return `Onverwachte uitkomst: ${result.kind}.`;
  }
}

/** Wat de verwerking opleverde, vóór er iets over gemeld is. */
type Afloop =
  | { readonly kind: 'klaar'; readonly uitkomst: EvalKnopUitkomst }
  | {
      readonly kind: 'probleem';
      readonly reden: string;
      /** Nee als het Systeem-bord hem al via een andere weg krijgt (`mail-mislukt`). */
      readonly opSysteembord: boolean;
      readonly line?: DailyLine;
      readonly klanttitel: string;
      readonly datum: string;
    };

type ProbleemAfloop = Extract<Afloop, { readonly kind: 'probleem' }>;

const probleemZonder = (reden: string): ProbleemAfloop => ({
  kind: 'probleem',
  reden,
  opSysteembord: true,
  klanttitel: '(onbekend)',
  datum: '(onbekend)',
});

/** De verwerking zelf. Werpt alleen bij een storing; de aanroeper maakt daar een melding van. */
async function verwerk(deps: EvalKnopDeps, itemId: string): Promise<Afloop> {
  const agenda = await deps.readAgenda();
  const entry = agenda.find((t) => t.trainingItemId === itemId);
  if (entry === undefined || !entry.live) {
    return probleemZonder('Deze training staat niet op een actief agendabord.');
  }

  const training = await deps.readTraining(itemId);
  if (training === null) {
    return probleemZonder('De training is niet meer te vinden in Monday.');
  }
  const over = {
    klanttitel: training.klanttitel,
    datum: training.datum ?? '(geen datum)',
  };
  const probleem = (reden: string): ProbleemAfloop => ({
    kind: 'probleem',
    reden,
    opSysteembord: true,
    ...over,
  });

  if (training.datum === null) {
    return probleem('De training heeft geen datum.');
  }
  if (training.datum > deps.vandaag()) {
    return probleem(
      `De training is nog niet geweest (${nlDatum(training.datum)}), dus er zijn nog geen ` +
        'evaluaties om een rapport van te maken.'
    );
  }

  const [responses, labels] = await Promise.all([deps.readResponses(), deps.readLabels()]);
  /** Over de HELE agenda, net als de dagjob: anders is een gedeelde code niet te herkennen. */
  const attribution = attributeResponses(
    responses,
    agenda.map((t) => t.ref)
  );
  const ambiguous = new Set(attribution.report.trainingsWithAmbiguousCode);
  const label = training.labelCode === null ? undefined : labels.get(training.labelCode);
  const mine = attribution.responsesByTraining.get(itemId) ?? [];
  const result = classify(training, label, mine, ambiguous);

  if (result.kind === 'no_code') {
    return { kind: 'klaar', uitkomst: { status: 'geen-ie-code' } };
  }
  if (result.kind !== 'ok' && result.kind !== 'no_responses') {
    const mijnCodes = new Set(codesIn(training.rawIeCode));
    /** Deze training én de andere met dezelfde code, zodat de melding ze kan vergelijken. */
    const groep = agenda
      .filter(
        (t) => t.trainingItemId === itemId || codesIn(t.ref.rawIeCode).some((c) => mijnCodes.has(c))
      )
      .map((t) => ({
        itemId: t.trainingItemId,
        datum: t.datum,
        clientKey: t.ref.clientKey,
        themaKey: t.ref.themaKey,
      }));
    return probleem(redenVoor(result, training, groep));
  }

  const verwerkt = await verwerkTraining(
    deps,
    { itemId, boardId: entry.boardId },
    training,
    label,
    mine,
    result,
    { dryRun: false, force: true }
  );
  if (verwerkt.mailFailed) {
    return {
      ...probleem(
        `Het bord is bijgewerkt, maar de mails zijn niet verstuurd: ${verwerkt.line.mailNote}`
      ),
      /** Op het Systeem-bord staat hij al als `mail-mislukt`; een tweede melding is ruis. */
      opSysteembord: false,
      line: verwerkt.line,
    };
  }
  return { kind: 'klaar', uitkomst: { status: 'leeg', line: verwerkt.line } };
}

/** Alle stappen proberen, en daarna de eerste mislukking doorgeven. */
async function allemaal(stappen: readonly Promise<unknown>[]): Promise<void> {
  const uitkomsten = await Promise.allSettled(stappen);
  const mislukt = uitkomsten.find((u) => u.status === 'rejected');
  if (mislukt !== undefined && mislukt.status === 'rejected') {
    throw mislukt.reason;
  }
}

/**
 * Verwerk één knopdruk.
 *
 * Een storing eindigt als `Zie Systeem-bord` en niet als stilte: `Eval Status` is op dat
 * moment al leeg, en dan lijkt het alsof de knop niets deed.
 *
 * **Het melden is één blok waarin alles geprobeerd wordt.** Het antwoord aan Monday is al
 * weg, dus een mislukte stap kan nergens meer heen dan het log. Een statusschrijving die
 * Monday weigert mag daarom de KV-melding en de update niet meenemen: die zijn het enige spoor
 * dat blijft. Werpt pas daarna, met de eerste fout, zodat de route hem logt.
 */
export async function runEvalKnop(
  deps: EvalKnopDeps,
  itemId: string,
  boardId: string
): Promise<EvalKnopUitkomst> {
  /**
   * Zoals legacy: eerst leegmaken, zodat de knop meteen opnieuw ingedrukt kan worden.
   *
   * Mislukt dat, dan tóch verwerken en het aan het eind opnieuw proberen. Stoppen zou de
   * training op RUN laten staan zonder dat er iets gebeurt, en vanaf RUN vuurt de volgende
   * druk op de knop niet meer.
   */
  const leegGelukt = await deps
    .setEvalStatus(itemId, boardId, 'leeg')
    .then(() => true)
    .catch(() => false);

  let afloop: Afloop;
  try {
    afloop = await verwerk(deps, itemId);
  } catch (error) {
    afloop = probleemZonder(
      `Er ging iets mis bij het maken van het rapport: ${describeError(error)}`
    );
  }

  if (afloop.kind === 'klaar') {
    const status = afloop.uitkomst.status;
    await allemaal([
      status !== 'leeg' || !leegGelukt
        ? deps.setEvalStatus(itemId, boardId, status)
        : Promise.resolve(),
      deps.problemen.clear(itemId),
    ]);
    return afloop.uitkomst;
  }

  await allemaal([
    deps.setEvalStatus(itemId, boardId, 'zie-systeembord'),
    /**
     * Zonder eigen melding (`mail-mislukt` meldt dit al) ruimt hij wél een oudere op: die
     * ging over een oorzaak die deze druk voorbij is gekomen.
     */
    afloop.opSysteembord
      ? deps.problemen.record({
          itemId,
          klanttitel: afloop.klanttitel,
          datum: afloop.datum,
          reden: afloop.reden,
          atMs: deps.nowMs(),
        })
      : deps.problemen.clear(itemId),
    deps.postUpdate(
      itemId,
      `Eval Rapport niet gelukt: ${afloop.reden}\n\nPas het aan en druk opnieuw op Eval Rapport.`
    ),
  ]);
  return { status: 'zie-systeembord', reden: afloop.reden, line: afloop.line };
}
