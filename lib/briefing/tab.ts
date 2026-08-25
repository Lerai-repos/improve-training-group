/**
 * Wat de app-tab op het agenda-item laat zien.
 *
 * Eén functie die uit een training plus de opgeslagen antwoorden alles samenstelt wat het
 * scherm nodig heeft. Puur: geen Monday, geen KV, geen netwerk — die worden erboven gelezen
 * en hier ingegeven, zodat elk geval dat op het bord zeldzaam is hier gewoon een test is.
 *
 * De tab is de **trigger** van de hele briefing: er is geen webhook, een mens drukt op
 * Genereren. Dit bestand bepaalt dus ook wat er dán zou gebeuren — hoeveel documenten, voor
 * wie, en met welke rol — zodat het scherm dat kan tonen vóórdat er iets gemaakt wordt.
 */

import { countLinkedActors } from './compose';
import { prefillTrainingActor, type BriefingChecklist } from './blocks';
import { conceptLines, resolveConceptInhoud } from './concept';
import { formatDutchDate } from './deadline';
import { resolveRecipientRoles, type RecipientRole } from './recipients';
import { EMPTY_SAVED, type SavedChecklist } from './answers';

import type { BriefingTraining, BriefingTrainer } from './types';

/** Eén gekoppelde persoon, zoals de tab hem toont bij de acteurvraag. */
export interface TabPerson {
  readonly itemId: string;
  readonly naam: string;
  /** Staat in de groep `Acteurs` op het trainersbord. Een aanwijzing, geen antwoord. */
  readonly inActeursGroep: boolean;
  /** Staat in de kolom Co-trainer(s) op het agendabord. */
  readonly isCoTrainer: boolean;
  /** Door de adviseur aangewezen als acteur van déze sessie. */
  readonly aangewezenAlsActeur: boolean;
}

/** Wat er uit Genereren zou komen: één regel per document. */
export interface TabDocument {
  readonly itemId: string;
  readonly naam: string;
  readonly role: RecipientRole;
}

/**
 * Waarom er niet gegenereerd kan worden, in de woorden die het scherm toont.
 *
 * Geen foutmeldingen maar opdrachten: elk geval heeft een handeling die het oplost, en die
 * staat erbij. `blokkeert` scheidt "dit kan echt niet" van "dit kan wel, maar let op".
 */
export interface TabIssue {
  readonly kind:
    | 'geen_lead'
    | 'acteur_onbekend'
    | 'acteur_onbeantwoord'
    | 'interne_trainer'
    | 'veld_leeg';
  readonly tekst: string;
  readonly blokkeert: boolean;
}

export interface TabView {
  readonly training: {
    readonly itemId: string;
    readonly naam: string;
    readonly opdrachtgever: string;
    readonly klanttitel: string;
    readonly datum: string;
    readonly label: string;
    readonly brie: string;
  };
  readonly checklist: BriefingChecklist;
  readonly actorItemIds: readonly string[];
  readonly mondayChallenge: boolean;
  /** Wat Monday over de acteurvraag suggereert; het scherm zet hem voor, de adviseur beslist. */
  readonly acteurVoorstel: boolean;
  /** Is de acteurvraag door een mens beantwoord, of staat de suggestie er nog? */
  readonly acteurBeantwoord: boolean;
  readonly personen: readonly TabPerson[];
  /** Het skelet van het thema, als regels. Vult het tekstvak voor. */
  readonly conceptSkelet: readonly string[];
  /** Wat de adviseur zelf heeft getypt, of `null` als hij het niet heeft aangeraakt. */
  readonly conceptEigen: string | null;
  /** De regels zoals ze in het document zouden komen, met `{organisatie}` ingevuld. */
  readonly conceptResultaat: readonly string[];
  readonly documenten: readonly TabDocument[];
  readonly issues: readonly TabIssue[];
  readonly kanGenereren: boolean;
}

/** De trainingen waar volgens `Brie` helemaal geen briefing voor komt. */
const INTERNE_TRAINER = 'Interne trainer';

function personen(training: BriefingTraining, aangewezen: readonly string[]): TabPerson[] {
  const gekozen = new Set(aangewezen);
  return training.trainers.map((t: BriefingTrainer) => ({
    itemId: t.itemId,
    naam: t.naam,
    inActeursGroep: t.isActeur,
    isCoTrainer: t.isCoTrainer,
    aangewezenAlsActeur: gekozen.has(t.itemId),
  }));
}

/**
 * De velden die leeg zijn en in het document een zichtbare `«…»`-regel worden.
 *
 * Dit blokkeert niet. Dirkje's eigen wens was *"joh, er ontbreekt nog informatie"* — dus
 * melden, niet tegenhouden: het document komt er wel, en de adviseur ziet precies wat er
 * ontbreekt in plaats van een knop die niets doet.
 */
function legeVelden(training: BriefingTraining): TabIssue[] {
  return training.missing.map((veld) => ({
    kind: 'veld_leeg' as const,
    tekst: `${veld.label} is leeg; dat wordt een zichtbare regel in het document`,
    blokkeert: false,
  }));
}

/**
 * Alles wat de tab toont voor één training.
 *
 * `saved` is wat er in KV staat; zonder opgeslagen antwoorden begint het scherm leeg, met de
 * acteurvraag voorgezet op wat Monday suggereert.
 */
export function buildTabView(
  training: BriefingTraining,
  saved: SavedChecklist | null
): TabView {
  const antwoorden = saved ?? EMPTY_SAVED;
  const voorstel = prefillTrainingActor(training.acteuraantal, countLinkedActors(training));

  /**
   * Onbeantwoord betekent: neem het voorstel over. Niet "nee".
   *
   * Zou een onaangeraakte tab de acteurvraag op `false` zetten, dan verdwijnt het acteurblok
   * uit elk document van een sessie mét acteur, zonder dat iemand een vraag heeft
   * overgeslagen — het scherm had immers al een antwoord ingevuld.
   *
   * "Beantwoord" is een eigen veld en niet "er staat iets opgeslagen". Dat laatste maakte het
   * aanvinken van *huiswerk* stilzwijgend tot bevestiging van het acteurvoorstel, terwijl dat
   * voorstel al als gekozen radioknop op het scherm stond en bevestigen dus geen wijziging
   * opleverde.
   */
  const beantwoord = antwoorden.actorAnswered;
  const checklist: BriefingChecklist = beantwoord
    ? antwoorden.checklist
    : { ...antwoorden.checklist, trainingActor: voorstel };

  const rollen = resolveRecipientRoles(training, checklist, {
    actorItemIds: antwoorden.actorItemIds,
  });

  const issues: TabIssue[] = [];
  if (training.brie === INTERNE_TRAINER) {
    issues.push({
      kind: 'interne_trainer',
      tekst: 'Brie staat op "Interne trainer"; voor deze training komt geen briefing',
      blokkeert: true,
    });
  }
  if (rollen.kind === 'no_single_lead') {
    const namen = rollen.leadCandidates.map((t) => t.naam).join(', ');
    issues.push({
      kind: 'geen_lead',
      tekst:
        rollen.leadCandidates.length === 0
          ? 'Er staat niemand in de kolom Trainers contactgegevens, dus er is geen leadtrainer. Zet er één trainer in.'
          : `Er staan ${rollen.leadCandidates.length} mensen in de leadkolom (${namen}), dus wie de lead is staat nergens. Zet de co-trainer(s) in de kolom Co-trainer(s).`,
      blokkeert: true,
    });
  }
  if (rollen.kind === 'ambiguous') {
    issues.push({
      kind: 'acteur_onbekend',
      tekst: `Acteuraantal belooft ${rollen.actorsUnaccounted} acteur(s) die niet in de groep Acteurs staan. Wijs hieronder aan wie de acteur is.`,
      blokkeert: true,
    });
  }
  if (!beantwoord) {
    issues.push({
      kind: 'acteur_onbeantwoord',
      tekst:
        `Beantwoord eerst of er een trainingsacteur meewerkt. Monday stelt ` +
        `${voorstel ? 'ja' : 'nee'} voor op basis van Acteuraantal en de groep Acteurs, maar ` +
        'die twee samen missen soms een acteur.',
      blokkeert: true,
    });
  }
  issues.push(...legeVelden(training));

  const documenten: TabDocument[] =
    rollen.kind === 'resolved'
      ? rollen.recipients.map((r) => ({
          itemId: r.trainer.itemId,
          naam: r.trainer.naam,
          role: r.role,
        }))
      : [];

  const eigen = checklist.conceptInhoud ?? null;
  return {
    training: {
      itemId: training.itemId,
      naam: training.naam,
      opdrachtgever: training.opdrachtgever,
      klanttitel: training.klanttitel,
      // Zoals in het document: "17 september 2026", niet de rauwe ISO-datum uit Monday.
      datum: formatDutchDate(training.datum ?? ''),
      label: training.label,
      brie: training.brie,
    },
    checklist,
    actorItemIds: antwoorden.actorItemIds,
    mondayChallenge: antwoorden.mondayChallenge,
    acteurVoorstel: voorstel,
    acteurBeantwoord: beantwoord,
    personen: personen(training, antwoorden.actorItemIds),
    conceptSkelet: conceptLines(training.themaInhoud),
    conceptEigen: eigen,
    conceptResultaat:
      resolveConceptInhoud({
        themaTekst: training.themaInhoud,
        adviseurTekst: eigen ?? undefined,
        organisatie: training.opdrachtgever,
      }) ?? [],
    documenten,
    issues,
    kanGenereren: !issues.some((i) => i.blokkeert),
  };
}
