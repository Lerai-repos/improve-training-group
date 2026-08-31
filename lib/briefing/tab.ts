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

import { BRIEFING_AGENDA_COLUMNS } from './columns';
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
    | 'acteur_niet_gekoppeld'
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
  /**
   * Precies één gekoppeld persoon, dus twee vragen zijn niet te beantwoorden.
   *
   * `Meerdere trainers op deze sessie` verdeelt groepen tussen trainers, en de acteurvraag
   * kan met één persoon niet op "ja" uitkomen: `classify` houdt dan een onverklaarde acteur
   * over, of maakt van de enige persoon de acteur en dan is er geen lead. Beide blokkeren.
   * Het scherm laat ze daarom weg; hier staat waarom dat mag.
   */
  readonly soloTrainer: boolean;
  /**
   * Er is hooguit één persoon gekoppeld, dus er valt geen groep te verdelen.
   *
   * Apart van `soloTrainer`, want dat is een ándere vraag. Bij één persoon uit de groep
   * Acteurs moet de acteurvraag juist wél gesteld worden, terwijl "meerdere trainers op deze
   * sessie" ook dan nergens over gaat. Aan één vlag opgehangen bleef de groepskeuze in dat
   * geval zichtbaar én ongemoeid, en kon "Ieder een eigen groep" in de briefing van een
   * eenpitter belanden.
   */
  readonly groepskeuzeNvt: boolean;
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
function legeVelden(training: BriefingTraining, onderdrukt: ReadonlySet<string>): TabIssue[] {
  return training.missing
    .filter((veld) => !onderdrukt.has(veld.column))
    .map((veld) => ({
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
export function buildTabView(training: BriefingTraining, saved: SavedChecklist | null): TabView {
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
  /**
   * Eén gekoppeld persoon: de twee vragen die daar niet over kunnen gaan, staan vast op nee.
   *
   * Ook als er iets anders is opgeslagen. Dat is geen theoretisch geval — een training kan
   * ooit twee trainers hebben gehad — en een blok over "ieder een eigen groep" in het
   * document van de enige trainer is erger dan een vraag te weinig.
   *
   * **En die ene persoon mag geen acteur zijn.** `training.trainers` bevat trainers én
   * acteurs. Zonder die voorwaarde gaat `trainingActor` op nee, telt de acteur als gewone
   * trainer, en promoveert `classify` hem tot lead — waarna er een leadbriefing naar een
   * acteur gaat, mét klantcontact en inhoudelijke verantwoordelijkheid. Zo'n training hoort
   * te blijven blokkeren op "geen leadtrainer", en dat doet ze zodra deze sluiproute
   * hem overslaat.
   */
  const soloTrainer = training.trainers.length === 1 && !training.trainers[0].isActeur;
  /** Nul of één persoon: er is niets te verdelen, ongeacht of die ene een acteur is. */
  const groepskeuzeNvt = training.trainers.length <= 1;

  const beantwoord = soloTrainer || antwoorden.actorAnswered;
  const gekozen: BriefingChecklist = antwoorden.actorAnswered
    ? antwoorden.checklist
    : { ...antwoorden.checklist, trainingActor: voorstel };
  const checklist: BriefingChecklist = {
    ...gekozen,
    ...(soloTrainer ? { trainingActor: false } : {}),
    ...(groepskeuzeNvt ? { ownGroup: false, sameGroup: false } : {}),
  };

  const rollen = resolveRecipientRoles(training, checklist, {
    actorItemIds: antwoorden.actorItemIds,
  });

  const issues: TabIssue[] = [];
  /**
   * Velden waarover elders al iets scherpers staat, zodat ze niet twee keer gemeld worden.
   *
   * "Er staat niemand in de kolom Trainers contactgegevens" en "Trainer is leeg" zijn
   * hetzelfde feit in twee zinnen, en op één scherm naast elkaar lezen ze als twee losse
   * problemen. De eerste zegt óók wat je eraan doet, dus die blijft.
   */
  const onderdrukt = new Set<string>();
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
    onderdrukt.add(BRIEFING_AGENDA_COLUMNS.trainerRelation);
  }
  if (rollen.kind === 'ambiguous') {
    issues.push({
      kind: 'acteur_onbekend',
      tekst: `Acteuraantal belooft ${rollen.actorsUnaccounted} acteur(s) die niet in de groep Acteurs staan. Wijs hieronder aan wie de acteur is.`,
      blokkeert: true,
    });
  }
  /**
   * Eén persoon, maar Monday belooft een acteur. Gemeten: 4 van de 265 komende trainingen.
   *
   * Dit is de enige reden dat de acteurvraag niet zomaar op nee mag: er staat "1 acteur" en
   * er is niemand gekoppeld, dus de acteur bestaat waarschijnlijk wel en is alleen niet
   * ingevuld. Stilzwijgend doorgaan levert een briefing zonder acteurblok. Blokkeren dus —
   * net als vandaag, alleen met een zin die zegt wat eraan te doen is in plaats van een
   * vraag die met één gekoppeld persoon geen goed antwoord heeft.
   */
  if (soloTrainer && (training.acteuraantal ?? 0) >= 1) {
    issues.push({
      kind: 'acteur_niet_gekoppeld',
      tekst: `Acteuraantal belooft ${training.acteuraantal} acteur(s), maar er is maar één persoon gekoppeld. Koppel de acteur aan de training.`,
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
  issues.push(...legeVelden(training, onderdrukt));

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
    soloTrainer,
    groepskeuzeNvt,
    actorItemIds: antwoorden.actorItemIds,
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
