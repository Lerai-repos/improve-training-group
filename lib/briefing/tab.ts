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

import { BRIEFING_AGENDA_COLUMNS, OPPORTUNITY_COLUMNS } from './columns';
import { BRIEFING_REQUIRED_FIELDS } from './required';
import {
  ACHTERGROND_LEEG,
  REIS_ONBEKEND,
  composeBriefing,
  countLinkedActors,
  openIssues,
  sessionFacts,
} from './compose';
import { describeOpenIssue, isNotDecided, splitOpenIssue } from './open-issues';
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
    | 'veld_leeg'
    | 'onbepaald';
  readonly tekst: string;
  readonly blokkeert: boolean;
}

/**
 * Het overzicht bovenaan de tab: wat er nog mist, en of de briefing compleet is.
 *
 * **Telt alleen wat de adviseur zelf kan oplossen.** Een bron die Lerai nog niet heeft gebouwd,
 * zoals de inventarisatie, staat wel als zichtbare regel in het document maar niet in deze
 * lijst. Anders is geen enkele briefing ooit compleet. `recordInputFor` hanteert dezelfde
 * regel voor `Staat klaar`, zodat het label en de status hetzelfde zeggen.
 */
export interface TabGereedheid {
  readonly compleet: boolean;
  /** Eén regel per controle, problemen eerst. */
  readonly controles: readonly TabControle[];
}

/**
 * Eén regel van de checklist bovenaan de tab.
 *
 * `label` is een paar woorden, zodat de lijst in één oogopslag te lezen is; de uitleg klapt
 * open bij een klik. Bij een goede regel is de uitleg de waarde zelf, zodat de adviseur kan
 * zien dát het klopt en niet alleen dat er iets staat.
 */
export interface TabControle {
  readonly key: string;
  readonly label: string;
  /** `blokkeert` houdt genereren tegen; `ontbreekt` wordt een zichtbare regel in het document. */
  readonly status: 'ok' | 'ontbreekt' | 'blokkeert';
  readonly uitleg: string;
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
   * Er is hooguit één TRAINER, dus er valt geen groep te verdelen.
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
  readonly gereedheid: TabGereedheid;
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
 * De `nog niet bepaald`-regels die het document zou krijgen.
 *
 * Samengesteld zoals genereren het doet, maar zonder de gegevens die pas dan gelezen worden
 * (historie, updates, reistijd). Die ontbreken hier als `nog niet aangesloten` en vallen door
 * het filter weg. Wat overblijft is precies wat de adviseur nog kan oplossen, zoals een
 * QR-kolom op `0. NOTK` of een thema zonder bullets.
 */
function onbepaaldeRegels(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  actorItemIds: readonly string[]
): string[] {
  const data = composeBriefing(training, checklist, {
    roles: sessionFacts(training, checklist, { actorItemIds }),
  });
  const regels = openIssues(data).filter(
    (t) => isNotDecided(t) && t !== ACHTERGROND_LEEG && t !== REIS_ONBEKEND
  );
  return [...new Set(regels)];
}

/** Korte namen voor de `nog niet bepaald`-regels; de rest krijgt zijn eigen omschrijving. */
function korteNaam(wat: string): string {
  const w = wat.toLowerCase();
  if (w === 'evaluatie deelnemers') {
    return 'Evaluatie (QR)';
  }
  if (w === 'de organisatienaam in de concept-inhoud') {
    return 'Organisatienaam';
  }
  if (w === 'wie de trainingsacteur is') {
    return 'Acteur aanwijzen';
  }
  if (w.startsWith('de rol van')) {
    return 'Rolverdeling';
  }
  if (w.startsWith('verwijzing naar het kopje')) {
    return 'Huiswerkverwijzing';
  }
  return wat;
}

const VOLGORDE: Record<TabControle['status'], number> = { blokkeert: 0, ontbreekt: 1, ok: 2 };

/**
 * De checklist: wat klopt, wat ontbreekt, en wat genereren tegenhoudt.
 *
 * Gebouwd uit dezelfde feiten als `issues` en `training.missing`, zodat het label, de knop en
 * `Staat klaar` niet van de lijst kunnen afwijken. Alleen wat de adviseur kan oplossen staat
 * erin; de inventarisatie (nog niet gebouwd) niet.
 */
function controlesVoor(input: {
  readonly training: BriefingTraining;
  readonly issues: readonly TabIssue[];
  readonly regels: readonly string[];
  readonly documenten: readonly TabDocument[];
  readonly conceptResultaat: readonly string[];
  readonly soloTrainer: boolean;
  readonly acteurBeantwoord: boolean;
  readonly trainingActor: boolean;
}): TabControle[] {
  const { training, issues } = input;
  const C = BRIEFING_AGENDA_COLUMNS;
  const lijst: TabControle[] = [];
  const issue = (kind: TabIssue['kind']): TabIssue | undefined =>
    issues.find((i) => i.kind === kind);
  const mist = (column: string) => training.missing.find((m) => m.column === column);

  const lead = issue('geen_lead');
  if (lead !== undefined) {
    lijst.push({ key: 'lead', label: 'Leadtrainer', status: 'blokkeert', uitleg: lead.tekst });
  } else if (mist(C.trainerRelation) !== undefined) {
    lijst.push({
      key: 'lead',
      label: 'Leadtrainer',
      status: 'ontbreekt',
      uitleg:
        'Er hangt alleen een acteur aan deze training. Zet een trainer in de kolom Trainers ' +
        'contactgegevens op het agendabord.',
    });
  } else {
    lijst.push({
      key: 'lead',
      label: 'Trainers',
      status: 'ok',
      uitleg: input.documenten.map((d) => `${d.naam} (${ROL[d.role]})`).join(', '),
    });
  }

  const nietGekoppeld = issue('acteur_niet_gekoppeld');
  const onbekend = issue('acteur_onbekend');
  const onbeantwoord = issue('acteur_onbeantwoord');
  if (nietGekoppeld !== undefined) {
    lijst.push({
      key: 'acteur',
      label: 'Acteur koppelen',
      status: 'blokkeert',
      uitleg: nietGekoppeld.tekst,
    });
  } else if (onbeantwoord !== undefined) {
    lijst.push({
      key: 'acteur',
      label: 'Acteurvraag',
      status: 'blokkeert',
      uitleg: onbeantwoord.tekst,
    });
  } else if (onbekend !== undefined) {
    lijst.push({
      key: 'acteur',
      label: 'Acteur aanwijzen',
      status: 'blokkeert',
      uitleg: onbekend.tekst,
    });
  } else if (!input.soloTrainer) {
    lijst.push({
      key: 'acteur',
      label: 'Acteurvraag',
      status: 'ok',
      uitleg: input.trainingActor ? 'Er werkt een trainingsacteur mee.' : 'Geen trainingsacteur.',
    });
  }

  const intern = issue('interne_trainer');
  if (intern !== undefined) {
    lijst.push({
      key: 'intern',
      label: 'Interne trainer',
      status: 'blokkeert',
      uitleg: intern.tekst,
    });
  }

  const veld = (key: string, label: string, column: string, waarde: string): void => {
    const leeg = mist(column);
    lijst.push(
      leeg === undefined
        ? { key, label, status: 'ok', uitleg: waarde }
        : {
            key,
            label,
            status: 'ontbreekt',
            uitleg:
              leeg.label === label
                ? `De kolom ${label} is leeg. In het document komt op die plek een zichtbare regel; vul hem in Monday in.`
                : `${leeg.label}. Kies in Monday een label waarvoor een sjabloon bestaat.`,
          }
    );
  };
  for (const r of BRIEFING_REQUIRED_FIELDS) {
    veld(
      r.of,
      r.label,
      r.column,
      r.of === 'datum' ? formatDutchDate(training.datum) : training[r.of]
    );
  }
  veld('themas', "Thema's", C.themaRelation, training.themas.join(', '));
  veld('accountmanager', 'Accountmanager', C.accountmanager, training.accountmanager?.naam ?? '');
  veld(
    'achtergrond',
    'Achtergrondinformatie',
    OPPORTUNITY_COLUMNS.achtergrond,
    'Ingevuld op de gekoppelde Opportunity.'
  );

  const regels = input.regels.map(splitOpenIssue);
  const concept = regels.find((r) => r.wat.toLowerCase() === 'concept-inhoud');
  lijst.push(
    concept === undefined
      ? {
          key: 'concept',
          label: 'Concept inhoud',
          status: 'ok',
          uitleg: `${input.conceptResultaat.length} regel${input.conceptResultaat.length === 1 ? '' : 's'} in het document.`,
        }
      : {
          key: 'concept',
          label: 'Concept inhoud',
          status: 'ontbreekt',
          uitleg: `${concept.reden.charAt(0).toUpperCase()}${concept.reden.slice(1)}. Typ het programma bij Concept inhoud.`,
        }
  );
  regels
    .filter((r) => r !== concept)
    .forEach((r, index) => {
      lijst.push({
        key: `regel-${index}`,
        label: korteNaam(r.wat),
        status: 'ontbreekt',
        uitleg: `${r.reden.charAt(0).toUpperCase()}${r.reden.slice(1)}.`,
      });
    });

  return lijst
    .map((controle, index) => ({ controle, index }))
    .sort((a, b) => VOLGORDE[a.controle.status] - VOLGORDE[b.controle.status] || a.index - b.index)
    .map(({ controle }) => controle);
}

const ROL: Record<RecipientRole, string> = {
  lead: 'lead',
  co: 'co-trainer',
  acteur: 'acteur',
};

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

  const beantwoord = soloTrainer || antwoorden.actorAnswered;
  const gekozen: BriefingChecklist = antwoorden.actorAnswered
    ? antwoorden.checklist
    : { ...antwoorden.checklist, trainingActor: voorstel };
  const metActeurkeuze: BriefingChecklist = soloTrainer
    ? { ...gekozen, trainingActor: false }
    : gekozen;

  const rollen = resolveRecipientRoles(training, metActeurkeuze, {
    actorItemIds: antwoorden.actorItemIds,
  });

  /**
   * De groepsvraag telt TRAINERS, niet gekoppelde personen.
   *
   * "Meerdere trainers op deze sessie" gaat over het verdelen van de groep tússen trainers;
   * een acteur krijgt geen eigen groep. Op het aantal gekoppelde personen tellen zette de
   * vraag op lead+acteur-sessies — 3 van de 4 trainingen die hem zouden krijgen — terwijl
   * daar één trainer staat.
   *
   * Ná `resolveRecipientRoles`, want pas dáár is uitgemaakt wie er als acteur telt: dat
   * hangt af van het antwoord op de acteurvraag, niet alleen van de groep `Acteurs`.
   */
  const trainers =
    rollen.kind === 'resolved'
      ? rollen.recipients.filter((r) => r.role !== 'acteur').length
      : training.trainers.filter((t) => !t.isActeur).length;
  const groepskeuzeNvt = trainers <= 1;

  const checklist: BriefingChecklist = groepskeuzeNvt
    ? { ...metActeurkeuze, ownGroup: false, sameGroup: false }
    : metActeurkeuze;

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
        'Kies bij Keuzes of er een trainingsacteur meewerkt. Monday weet het niet zeker: ' +
        'Acteuraantal en de groep Acteurs missen samen soms een acteur.',
      blokkeert: true,
    });
  }
  issues.push(...legeVelden(training, onderdrukt));
  const regels = onbepaaldeRegels(training, checklist, antwoorden.actorItemIds);
  issues.push(
    ...regels.map((t) => ({
      kind: 'onbepaald' as const,
      tekst: describeOpenIssue(t),
      blokkeert: false,
    }))
  );

  const documenten: TabDocument[] =
    rollen.kind === 'resolved'
      ? rollen.recipients.map((r) => ({
          itemId: r.trainer.itemId,
          naam: r.trainer.naam,
          role: r.role,
        }))
      : [];

  const eigen = checklist.conceptInhoud ?? null;
  const conceptResultaat =
    resolveConceptInhoud({
      themaTekst: training.themaInhoud,
      adviseurTekst: eigen ?? undefined,
      organisatie: training.opdrachtgever,
    }) ?? [];
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
    conceptResultaat,
    documenten,
    issues,
    gereedheid: {
      compleet: issues.length === 0,
      controles: controlesVoor({
        training,
        issues,
        regels,
        documenten,
        conceptResultaat,
        soloTrainer,
        acteurBeantwoord: beantwoord,
        trainingActor: checklist.trainingActor,
      }),
    },
    kanGenereren: !issues.some((i) => i.blokkeert),
  };
}
