import { LABEL_CODES, resolveLabelCode } from '@lib/labels';
import { normaliseHex } from '@lib/labels/validate';

import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { Finding, LabelFieldIssue } from './types';

/** Hoe vaak elke labelwaarde en elk thema-item op de agendaborden voorkomt. */
export interface AgendaUsage {
  /** Rúwe waarde uit de kolom Label, precies zoals die op de agenda staat. */
  readonly labels: ReadonlyMap<string, number>;
  /** Thema-item-id → aantal trainingen dat ernaar verwijst. */
  readonly themas: ReadonlyMap<string, number>;
  /** Trainer-item-id → aantal trainingen. Lead- én co-trainers, in één telling. */
  readonly trainers: ReadonlyMap<string, number>;
}

/** Eén rij van het Thema's-bord, voor zover de controle er iets van wil weten. */
export interface ThemaRecord {
  readonly naam: string;
  readonly conceptInhoud: string;
}

/**
 * Welke velden van een label "volledig ingesteld" betekenen.
 *
 * **Alleen wat vandaag ook echt gelezen wordt.** De ondertekende scope belooft een seintje bij
 * een label dat *"nog niet, of niet volledig, is ingesteld"* — maar een leeg veld dat nergens
 * wordt uitgelezen breekt niets, en er elke ochtend over klagen is precies hoe een
 * signaleringsbord wallpaper wordt.
 *
 * Bewust NIET in deze lijst, met de reden erbij:
 *
 * | veld | waarom nog niet |
 * |---|---|
 * | `term` | door niets gelezen; zie de notitie bij het Labels-bord |
 * | `evaluatieformulier` | het rapport verwijst er (nog) niet naar |
 * | `website` | wacht op de acht label-URL's, M5 |
 * | `inventarisatieformulier` | de bron zelf is nog niet gebouwd — dan is de LINK niet het gat |
 *
 * Zodra een van die vier wél gelezen wordt hoort hij hier bij, en dan meldt de controle hem
 * vanzelf. Dat is de bedoeling: de lijst volgt wat er kapot kan.
 */
export const LABEL_REQUIRED_FIELDS: readonly string[] = [
  'volledigeNaam',
  'kleur',
  'rapportterm',
  'logo',
  'voorblad',
  'achterblad',
];

/**
 * De onbruikbare velden van één labelrij, in de volgorde van `LABEL_REQUIRED_FIELDS`.
 *
 * "Onbruikbaar" en niet alleen "leeg": een kleur die geen geldige hexwaarde is doet in het
 * rapport precies wat een lege doet, namelijk niets goeds. Zou die alleen de strikte lezer
 * laten werpen, dan valt de hele labelcontrole om — inclusief de melding over onbekende
 * labels — voor één typefout in één cel.
 */
export function unusableLabelFields(record: LabelRecord): readonly LabelFieldIssue[] {
  const issues: LabelFieldIssue[] = [];
  const leegAls = (veld: string, waarde: string): void => {
    if (waarde.trim() === '') {
      issues.push({ veld, reden: 'leeg' });
    }
  };

  leegAls('volledigeNaam', record.volledigeNaam);
  if (record.kleur.trim() === '') {
    issues.push({ veld: 'kleur', reden: 'leeg' });
  } else if (normaliseHex(record.kleur) === null) {
    issues.push({ veld: 'kleur', reden: 'ongeldig' });
  }
  leegAls('rapportterm', record.rapportterm);

  for (const [veld, asset] of [
    ['logo', record.logo],
    ['voorblad', record.voorblad],
    ['achterblad', record.achterblad],
  ] as const) {
    if (asset === null) {
      issues.push({ veld, reden: 'leeg' });
    }
  }
  return issues;
}

/**
 * De labelmeldingen.
 *
 * Drie soorten, in oplopende ernst van "we weten niet wat dit is" naar "we weten het wel maar
 * een veld is leeg". Een labelwaarde die naar nul trainingen verwijst kan niet voorkomen —
 * `usage.labels` telt juist trainingen — maar een lege cel wél, en die is geen label: een
 * training zonder label is een ander probleem dan een label zonder configuratie, en het hoort
 * niet in deze melding thuis.
 */
export function labelFindings(
  usage: AgendaUsage,
  configured: ReadonlyMap<LabelCode, LabelRecord>
): readonly Finding[] {
  const found: Finding[] = [];
  /** Codes die via een alias op dezelfde configuratie uitkomen, samengeteld. */
  const perCode = new Map<LabelCode, number>();

  for (const [raw, trainingen] of usage.labels) {
    if (raw.trim() === '') {
      continue;
    }
    const code = resolveLabelCode(raw);
    if (code === null) {
      found.push({ kind: 'onbekend-label', label: raw, trainingen });
      continue;
    }
    perCode.set(code, (perCode.get(code) ?? 0) + trainingen);
  }

  /**
   * In de volgorde van `LABEL_CODES` en niet in die van de agenda.
   *
   * `usage.labels` komt uit een Map die op leesvolgorde staat, en die verschilt per run zodra
   * ITG een training toevoegt. Dan zou de melding-volgorde per nacht wisselen zonder dat er
   * iets veranderd is — onhandig bij het vergelijken van twee runs.
   */
  for (const code of LABEL_CODES) {
    const trainingen = perCode.get(code);
    if (trainingen === undefined) {
      continue;
    }
    const record = configured.get(code);
    if (record === undefined) {
      found.push({ kind: 'label-ontbreekt', code, trainingen });
      continue;
    }
    const velden = unusableLabelFields(record);
    if (velden.length > 0) {
      found.push({ kind: 'label-onvolledig', code, velden, trainingen });
    }
  }

  return found;
}

/**
 * De themameldingen.
 *
 * Loopt over de VERWIJZINGEN en niet over het bord: een thema dat op het bord staat maar door
 * geen enkele training wordt gebruikt kan geen briefing breken. Zes van zulke thema's staan er
 * nu (gemeten 4-Sep-2026), en die zouden anders elke ochtend meekomen.
 */
export function themaFindings(
  usage: AgendaUsage,
  live: ReadonlyMap<string, ThemaRecord>
): readonly Finding[] {
  const found: Finding[] = [];
  /** Gesorteerd op id, om dezelfde reden als bij de labels: een stabiele volgorde. */
  const ids = [...usage.themas.keys()].sort();

  for (const themaId of ids) {
    const trainingen = usage.themas.get(themaId) ?? 0;
    const record = live.get(themaId);
    if (record === undefined) {
      found.push({ kind: 'thema-ontbreekt', themaId, trainingen });
      continue;
    }
    if (record.conceptInhoud.trim() === '') {
      found.push({ kind: 'thema-zonder-inhoud', themaId, naam: record.naam, trainingen });
    }
  }

  return found;
}

/**
 * Trainers waarnaar verwezen wordt maar die niet meer bestaan.
 *
 * `docs/build/02-datamodel-monday.md:252` vraagt hier expliciet om, naast de thema's: *"Een
 * training die naar een niet-bestaand thema of trainer wijst"*. Het is dezelfde identiteitsval
 * — een trainer verwijderen en opnieuw aanmaken geeft een nieuw id, de geschiedenis blijft
 * achter bij het oude, en de statistiek splitst zonder foutmelding in tweeën.
 *
 * Loopt over de VERWIJZINGEN, net als bij de thema's: een trainer die op het trainersbord staat
 * maar nergens is ingepland kan niets breken.
 */
export function trainerFindings(usage: AgendaUsage, live: ReadonlySet<string>): readonly Finding[] {
  return [...usage.trainers.keys()]
    .sort()
    .filter((id) => !live.has(id))
    .map((trainerId) => ({
      kind: 'trainer-ontbreekt' as const,
      trainerId,
      trainingen: usage.trainers.get(trainerId) ?? 0,
    }));
}
