import { labelFindings, themaFindings, trainerFindings } from './findings';
import { withBoardLease } from './lease';
import { groupMoves, staleClosedByMarkers } from './move';
import { reconcile } from './reconcile';
import { failureKey, rowForFailure, rowForFinding } from './text';
import { applyActions, dutchDate, SUMMARY_KEY } from './write';
import { findingKey } from './types';

import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { AgendaUsage, ThemaRecord } from './findings';
import type { SignalGroupIds } from './groups';
import type { LeaseDeps } from './lease';
import type { ExistingSignal, SignalAction } from './reconcile';
import type { SignalWriter } from './write';
import type { Finding, FindingKind } from './types';

/** Welke soorten meldingen bij welke controle horen — het bereik van de opruimstap. */
const LABEL_KINDS: readonly FindingKind[] = [
  'onbekend-label',
  'label-ontbreekt',
  'label-onvolledig',
];
const THEMA_KINDS: readonly FindingKind[] = ['thema-ontbreekt', 'thema-zonder-inhoud'];
const TRAINER_KINDS: readonly FindingKind[] = ['trainer-ontbreekt'];

export interface DailyCheckDeps {
  readonly readSignals: () => Promise<readonly ExistingSignal[]>;
  readonly readAgendaUsage: () => Promise<AgendaUsage>;
  readonly readLabels: () => Promise<ReadonlyMap<LabelCode, LabelRecord>>;
  readonly readThemas: () => Promise<ReadonlyMap<string, ThemaRecord>>;
  /** De ids van elk bestaand trainer-item, voor de verweesde-verwijzingcontrole. */
  readonly readTrainers: () => Promise<ReadonlySet<string>>;
  /** `null` in een droogloop: dan wordt er niets geschreven, ook niet de samenvatting. */
  readonly writer: SignalWriter | null;
  readonly groups: SignalGroupIds;
  readonly now: () => Date;
}

export interface CheckFailure {
  readonly check: string;
  readonly error: string;
}

export interface DailyCheckReport {
  readonly dryRun: boolean;
  readonly findings: readonly Finding[];
  /**
   * De tellingen hieronder zijn de VOORGENOMEN acties.
   *
   * In een echte run is dat hetzelfde als het uitgevoerde aantal — `applyActions` voert elke
   * actie uit of werpt. In een droogloop is het wat er zou gebeuren. Ze op nul zetten in een
   * droogloop leverde een rapport op dat zichzelf tegensprak: de samenvattingstekst meldde
   * "Nieuw deze run: 2" en het regeltje eronder "nieuw: 0". De aanroeper zegt in woorden of
   * het uitgevoerd is; het getal blijft hetzelfde.
   */
  /** Vondsten die deze run nieuw op het bord zijn gezet. */
  readonly created: number;
  /** Bestaande meldingen waarvan de cijfers zijn bijgewerkt. */
  readonly updated: number;
  /** Meldingen die de controle eerder zelf afvinkte en die nu terug zijn. */
  readonly reopened: number;
  /** Openstaande meldingen die de controle zelf heeft afgevinkt. */
  readonly resolved: number;
  /** Rijen die naar een andere groep zijn verplaatst — afgevinkt eruit, ontvinkt weer terug. */
  readonly moved: number;
  readonly failures: readonly CheckFailure[];
  readonly trainingen: number;
  readonly summary: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Draait één controle en vangt zijn fout op.
 *
 * Vangt met opzet per controle en niet om de hele run: valt het Labels-bord weg, dan is dat
 * geen reden om ook de themacontrole over te slaan. Wat er níét gebeurt is dat een mislukte
 * controle als "niets gevonden" doorgaat — de soorten van een mislukte controle komen niet in
 * `checked`, en `reconcile` raakt dan geen enkele openstaande melding van die soort aan.
 */
async function attempt(
  check: string,
  kinds: readonly FindingKind[],
  run: () => Promise<readonly Finding[]>
): Promise<{
  /** Welke controle dit was — nodig om te weten of we over zijn storingsrij mogen oordelen. */
  check: string;
  findings: readonly Finding[];
  checked: readonly FindingKind[];
  failure: CheckFailure | null;
}> {
  try {
    return { check, findings: await run(), checked: kinds, failure: null };
  } catch (error) {
    return { check, findings: [], checked: [], failure: { check, error: message(error) } };
  }
}

/**
 * De dagelijkse controle.
 *
 * Wat er GEEN onderdeel van is: repareren. De controle schrijft alleen naar het Systeem-bord —
 * nooit naar de agenda, het Labels-bord of het Thema's-bord. Dat is de afspraak uit
 * `02-datamodel-monday.md`: *"als controle, niet als reparatie"*.
 */
export async function runDailyCheck(deps: DailyCheckDeps): Promise<DailyCheckReport> {
  const dryRun = deps.writer === null;

  /**
   * Het bord lezen is de enige stap die niet mag falen.
   *
   * Zonder te weten wat er al staat is elke keuze fout: doorgaan zou elke melding opnieuw
   * plaatsen, en overslaan zou een echte vondst laten liggen. Dit werpt dus.
   */
  const existing = await deps.readSignals();

  /**
   * De agenda is de gedeelde invoer van beide controles. Valt die weg, dan is er niets te
   * controleren en mag er ook niets worden opgeruimd — vandaar dat de fout hier tot allebei
   * de controles doordringt in plaats van tot één.
   */
  let usage: AgendaUsage | null = null;
  let agendaFailure: CheckFailure | null = null;
  try {
    usage = await deps.readAgendaUsage();
  } catch (error) {
    agendaFailure = { check: 'agenda', error: message(error) };
  }

  const results =
    usage === null
      ? []
      : [
          await attempt('labels', LABEL_KINDS, async () =>
            labelFindings(usage, await deps.readLabels())
          ),
          await attempt('themas', THEMA_KINDS, async () =>
            themaFindings(usage, await deps.readThemas())
          ),
          await attempt('trainers', TRAINER_KINDS, async () =>
            trainerFindings(usage, await deps.readTrainers())
          ),
        ];

  const findings = results.flatMap((r) => r.findings);
  const checked = results.flatMap((r) => r.checked);
  const failures = [
    ...(agendaFailure === null ? [] : [agendaFailure]),
    ...results.flatMap((r) => (r.failure === null ? [] : [r.failure])),
  ];

  /**
   * Vondsten én mislukte controles gaan door dezelfde molen.
   *
   * **Alleen de storingsrijen van controles die we ook echt hebben GEPROBEERD.** Valt de
   * agenda weg, dan zijn labels, thema's en trainers niet eens aan de beurt geweest; met een
   * prefix die "alle storingsrijen" dekt zou deze run de labelstoring van gisteren afvinken
   * zonder dat die controle ooit heeft gedraaid — herstel melden dat niemand heeft
   * vastgesteld. De agendastap zelf is altijd geprobeerd, dus die telt altijd mee.
   */
  const attempted = ['agenda', ...results.map((r) => r.check)].map(failureKey);
  const rows = [...findings.map(rowForFinding), ...failures.map(rowForFailure)];
  const actions = reconcile({ rows, existing, checked: [...checked, ...attempted] });
  const summary = summaryText({ now: deps.now(), usage, findings, existing, actions, failures });

  if (deps.writer === null) {
    return {
      dryRun,
      findings,
      // De voorgenomen aantallen, niet nul: zie de toelichting bij `DailyCheckReport`.
      ...plannedCounts(actions),
      /**
       * Ook de verplaatsingen worden vooruit berekend, mét de rijen die deze run zouden
       * worden afgevinkt of heropend — anders mist de droogloop juist de verplaatsingen die
       * uit haar eigen voorgenomen acties volgen. Een rij die iemand gisteren met de hand
       * afvinkte staat trouwens sowieso al scheef, en die telt hier ook in mee.
       */
      moved: groupMoves({
        existing,
        resolvedIds: plannedIds(actions, 'resolve'),
        reopenedIds: plannedIds(actions, 'reopen'),
        groups: deps.groups,
      }).length,
      failures,
      trainingen: totalTrainingen(usage),
      summary,
    };
  }

  const applied = await applyActions(deps.writer, actions, deps.groups.open);
  await writeSummary(deps.writer, existing, summary, deps.groups.samenvatting);

  /**
   * Verplaatsen NA het afvinken, en met de ids die deze run zijn afgevinkt erbij.
   *
   * `existing` is gelezen vóór de mutaties, dus die rijen staan daar nog op `afgehandeld:
   * false`. Zonder `resolvedIds` zou een melding die we net zelf hebben afgevinkt pas de
   * volgende nacht verhuizen, en dan staat er een dag lang een afgevinkte regel tussen de
   * openstaande.
   */
  const moves = groupMoves({
    existing,
    resolvedIds: applied.resolvedIds,
    reopenedIds: applied.reopenedIds,
    groups: deps.groups,
  });
  for (const move of moves) {
    await deps.writer.move(move);
  }

  for (const itemId of staleClosedByMarkers(existing, {
    reopenedIds: applied.reopenedIds,
    resolvedIds: applied.resolvedIds,
  })) {
    await deps.writer.clearClosedBy(itemId);
  }

  return {
    dryRun,
    findings,
    created: applied.created,
    updated: applied.updated,
    reopened: applied.reopened,
    resolved: applied.resolved,
    moved: moves.length,
    failures,
    trainingen: totalTrainingen(usage),
    summary,
  };
}

/** De item-ids van één soort voorgenomen actie. */
function plannedIds(actions: readonly SignalAction[], kind: 'resolve' | 'reopen'): string[] {
  return actions.flatMap((a) => (a.kind === kind ? [a.signal.itemId] : []));
}

function plannedCounts(actions: readonly SignalAction[]): {
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
} {
  const tel = (kind: SignalAction['kind']): number => actions.filter((a) => a.kind === kind).length;
  return {
    created: tel('create'),
    updated: tel('update'),
    reopened: tel('reopen'),
    resolved: tel('resolve'),
  };
}

function totalTrainingen(usage: AgendaUsage | null): number {
  if (usage === null) {
    return 0;
  }
  let total = 0;
  for (const n of usage.labels.values()) {
    total += n;
  }
  return total;
}

/**
 * Eén doorlopende samenvattingsrij, die elke run wordt bijgewerkt.
 *
 * Niet één rij per dag. Het bord is er voor wat er MIS is; 365 hartslagrijen per jaar zouden
 * de meldingen eronder bedelven, en de geschiedenis staat toch al in de logs. Wat deze rij
 * bewijst is dat de controle nog draait: staat het tijdstip op gisteren, dan is de job dood.
 */
async function writeSummary(
  writer: SignalWriter,
  existing: readonly ExistingSignal[],
  summary: string,
  groupId: string
): Promise<void> {
  const row = existing.find((s) => s.key === SUMMARY_KEY);
  if (row === undefined) {
    await writer.create({
      naam: 'Laatste controle',
      soort: 'Dagsamenvatting',
      onderdeel: 'Dagelijkse controle',
      detail: summary,
      sleutel: SUMMARY_KEY,
      groupId,
    });
    return;
  }
  await writer.updateSummary(row.itemId, summary);
}

interface SummaryInput {
  readonly now: Date;
  readonly usage: AgendaUsage | null;
  readonly findings: readonly Finding[];
  readonly existing: readonly ExistingSignal[];
  /**
   * De uitkomst van `reconcile`, niet van het uitvoeren ervan.
   *
   * Zo tellen een droogloop en een echte run hetzelfde: de droogloop toont precies wat er zou
   * komen te staan. En het lost het gat op waardoor de eerste run "Nieuw deze run: 23.
   * Openstaand: 0" schreef — `existing` is gelezen vóór de acties, dus die telling loopt altijd
   * één run achter op de werkelijkheid die in dezelfde zin wordt gemeld.
   */
  readonly actions: readonly SignalAction[];
  readonly failures: readonly CheckFailure[];
}

/**
 * De tekst van de samenvattingsrij.
 *
 * Telt de vondsten ALTIJD, ook de afgevinkte. Dat is het tegengif tegen de enige echte
 * zwakte van afvinken: wie "Label TMT — 7 trainingen" wegvinkt hoort er nooit meer van, ook
 * niet als het er volgend jaar 200 zijn. Het getal staat hier elke ochtend, los van de vraag
 * of er nog een melding voor openstaat.
 */
export function summaryText(input: SummaryInput): string {
  const tel = (kinds: readonly FindingKind[]): { meldingen: number; trainingen: number } => {
    const hits = input.findings.filter((f) => kinds.includes(f.kind));
    return {
      meldingen: hits.length,
      trainingen: hits.reduce((sum, f) => sum + f.trainingen, 0),
    };
  };

  const labels = tel(LABEL_KINDS);
  const themas = tel(THEMA_KINDS);
  const trainers = tel(TRAINER_KINDS);
  const keys = new Set(input.findings.map(findingKey));
  const count = (kind: SignalAction['kind']): number =>
    input.actions.filter((a) => a.kind === kind).length;

  /**
   * Wat er ná deze run openstaat, niet ervoor.
   *
   * `existing` is de foto van vóór de acties. Wie daaruit rechtstreeks telt schrijft op de
   * eerste run "Nieuw deze run: 23. Openstaand: 0", en meldt bij het afvinken van de laatste
   * melding nog steeds dat er één openstaat.
   */
  const openVoor = input.existing.filter(
    (s) => !s.afgehandeld && s.key !== SUMMARY_KEY && s.key.trim() !== ''
  ).length;
  const open = openVoor + count('create') + count('reopen') - count('resolve');

  /**
   * Alleen wat een MENS heeft weggezet en nog steeds waar is.
   *
   * Wat de controle zelf afvinkte en nu terug is, wordt deze run heropend en staat dus straks
   * open — dat hoort hier niet meer bij. Dit getal is het tegengif tegen de enige echte zwakte
   * van afvinken: wie "TMT — 7 trainingen" wegzet hoort er nooit meer van, ook niet bij 200.
   */
  const afgevinkt = input.existing.filter(
    (s) => s.afgehandeld && !s.closedByCheck && keys.has(s.key)
  ).length;

  const regels = [
    `Laatste controle: ${dutchDate(input.now)} ${input.now.toISOString().slice(11, 16)} UTC.`,
    input.usage === null
      ? 'De agenda kon niet gelezen worden — er is deze run niets gecontroleerd.'
      : `${totalTrainingen(input.usage)} trainingen, ${input.usage.labels.size} labelwaarden, ` +
        `${input.usage.themas.size} thema's, ${input.usage.trainers.size} trainers in gebruik.`,
    '',
    `Labels zonder (volledige) configuratie: ${labels.meldingen} ` +
      `(${labels.trainingen} trainingen).`,
    `Thema's zonder concept-inhoud of zonder item: ${themas.meldingen} ` +
      `(${themas.trainingen} trainingen).`,
    `Trainers die niet meer bestaan: ${trainers.meldingen} (${trainers.trainingen} trainingen).`,
    '',
    `Nieuw deze run: ${count('create')}. Bijgewerkt: ${count('update')}. ` +
      `Heropend: ${count('reopen')}. Opgelost: ${count('resolve')}.`,
    `Openstaand op dit bord: ${open}. Door ITG weggezet maar nog steeds zo: ${afgevinkt}.`,
  ];

  if (input.failures.length > 0) {
    regels.push(
      '',
      'LET OP — deze controles zijn NIET gedraaid, dus hun meldingen zijn deze run niet ' +
        'bijgewerkt of opgeruimd:',
      ...input.failures.map((f) => `  - ${f.check}: ${f.error}`)
    );
  }

  return regels.join('\n');
}

export type ExclusiveOutcome =
  | { readonly kind: 'ran'; readonly report: DailyCheckReport }
  /** Een andere run had de grendel. Er is niets gelezen en niets geschreven. */
  | { readonly kind: 'busy' };

/**
 * De dagelijkse controle, geserialiseerd per bord. **Dit is wat de cron en het script aanroepen.**
 *
 * `runDailyCheck` zelf grendelt niet, zodat hij zonder Redis te testen is. Wie hem rechtstreeks
 * aanroept in productie omzeilt de grendel — daar is deze functie voor.
 *
 * Zonder grendel is dit mogelijk, en niet theoretisch: de cron vuurt om 03:15 terwijl iemand
 * `pnpm daily:check --apply` draait, of Vercel probeert een cron opnieuw. Beide runs lezen het
 * bord, zien melding X niet staan, en maken hem allebei aan. **De idempotency-sleutel vangt dat
 * niet op** — die bevat met opzet het run-id, zodat een látere run een verwijderde melding
 * opnieuw mag plaatsen, dus twee gelijktijdige runs hebben twee verschillende sleutels voor
 * dezelfde rij. `docs/build/01-architectuur.md:73`: één worker per board, geserialiseerd.
 *
 * **Een droogloop grendelt niet.** Die schrijft niets, dus twee ervan kunnen elkaar niet in de
 * weg zitten — en belangrijker: een handmatige droogloop hoort de nachtelijke run niet te
 * blokkeren, en andersom hoort een lopende cron je niet te beletten even te kijken.
 */
export async function runDailyCheckExclusive(
  deps: DailyCheckDeps,
  lease: LeaseDeps,
  boardId: string
): Promise<ExclusiveOutcome> {
  if (deps.writer === null) {
    return { kind: 'ran', report: await runDailyCheck(deps) };
  }
  const outcome = await withBoardLease(lease, boardId, () => runDailyCheck(deps));
  return outcome.kind === 'busy' ? { kind: 'busy' } : { kind: 'ran', report: outcome.value };
}
