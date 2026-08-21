/**
 * De conditionele blokken: welke erin komen, en met welke tekst.
 *
 * De teksten hieronder staan **letterlijk** zoals ITG ze heeft aangeleverd in
 * `ITG Briefingteksten bij bijzonderheden.docx`. Dat document is de gesloten lijst waar
 * `06-briefing.md` over schrijft:
 *
 * > *De blokkenbibliotheek is een afgesloten lijst. Wat ITG heeft aangeleverd, bouwen we.
 * > Wat er niet in zit, doen zij met de hand, zoals nu.*
 *
 * Dus: hier niets bijschrijven, en niets herformuleren. Wijzigt ITG een tekst, dan wijzigt
 * dit bestand mee — met de bron erbij, niet uit het hoofd.
 *
 * ## Wat hier (nog) niet in staat
 *
 * De **rolafhankelijke** blokken — `Leadtrainer` versus `Co-trainer`, en `Werken met een
 * trainingsacteur` versus `Werken als trainingsacteur` — staan wel in het bronbestand maar
 * niet hier. Reden: één briefing gaat naar álle trainers van de sessie, en welke variant
 * iemand moet lezen hangt af van zijn rol. Monday legt die rol nergens vast. Dat is een
 * openstaande vraag aan Dirkje, en tot die beantwoord is zou elke keuze hier de helft van
 * de trainers de verkeerde tekst geven.
 */

import { notConnected, notDecided } from './open-issues';

/**
 * Eén blok zoals het sjabloon het invult: een kop, alinea's, en soms een afbeelding.
 *
 * `titel`, `regels` en `afbeelding` zijn Nederlands omdat het de veldnamen zijn die
 * lettterlijk in de negen `.docx`-sjablonen staan (`+++$blk.titel+++`,
 * `+++FOR r IN $blk.regels+++`). Hernoemen breekt het renderen zonder dat iets faalt.
 */
export interface BriefingBlock {
  readonly titel: string;
  readonly regels: readonly string[];
  /** Bestandsnaam in `lib/briefing/assets/`, of afwezig als het blok geen afbeelding heeft. */
  readonly afbeelding?: string;
  /**
   * De rijen van de historie-tabel, alleen bij het blok `Vaste klant`.
   *
   * Een échte Word-tabel in het sjabloon en geen alinea's met streepjes ertussen: zodra een
   * klanttitel of trainersnaam over twee regels loopt, staan de kolommen niet meer onder
   * elkaar. ITG's bronbestand vraagt hier letterlijk om een tabel.
   */
  readonly historie?: readonly HistoryRow[];
}

/**
 * Het cyclusschema dat ITG bij de blokteksten heeft aangeleverd.
 *
 * Staat in `ITG Briefingteksten bij bijzonderheden.docx` direct onder de alinea "Grofweg zie
 * de cyclus ziet er als onderstaand uit", en `06-briefing.md` noemt hem apart: het cyclusblok
 * is *"Lange uitleg … **Plus het cyclusschema als afbeelding**"*.
 */
const CYCLE_DIAGRAM = 'cyclusschema.png';

/**
 * Wat de training zélf zegt over wie er voor de groep staat.
 *
 * Dit komt uit Monday en niet uit de checklist, want het zijn de twee gevallen waarin een
 * blok verplicht is zonder dat de adviseur er iets voor hoeft aan te vinken.
 */
export interface SessionFacts {
  /**
   * Gekoppelde personen die **zeker** trainer zijn: niet in de groep `Acteurs`, en niet
   * nodig om het aantal acteurs te halen dat `Acteuraantal` belooft.
   *
   * De trainerrelatie mengt trainers en acteurs: gemeten heeft de combinatie
   * `Acteuraantal=1` met twee gekoppelde personen er 20 keer eentje uit de Acteurs-groep bij.
   * Zonder dat onderscheid telt de acteur mee als co-trainer, en dan krijgt de trainer een
   * blok over een co-trainer die er niet is.
   */
  readonly certainTrainers: number;
  /** Gekoppelde personen die wél in de groep `Acteurs` staan. */
  readonly identifiedActors: number;
  /**
   * Gekoppelde personen van wie de rol **niet te bepalen** is.
   *
   * Ontstaat wanneer `Acteuraantal` meer acteurs belooft dan er in de groep `Acteurs` te
   * vinden zijn. Gemeten komt dat 8 keer voor bij precies twee gekoppelde personen: er is
   * één acteur volgens de kolom, en geen van beiden staat in de groep. Wie van de twee het
   * is, staat nergens.
   *
   * `isActeur: false` betekent dus "niet in die groep gevonden" en niet "zeker trainer". Dat
   * verschil hier laten vallen levert precies het blok op dat deze scheiding moest
   * voorkomen: een tekst over een co-trainer die er niet is.
   */
  readonly unknownRole: number;
}

/** Het grootste aantal gekoppelde personen dat trainer kán zijn. */
function maxTrainers(session: SessionFacts): number {
  return session.certainTrainers + session.unknownRole;
}

/**
 * Het voorstel voor de checklistvraag over de trainingsacteur.
 *
 * Twee onafhankelijke aanwijzingen, en allebei zijn ze onvolledig: `Acteuraantal` staat 5 keer
 * leeg terwijl er wél een acteur gekoppeld is, en 8 keer op 1 terwijl niemand van de
 * gekoppelden in de Acteurs-groep zit. Samen dekken ze meer dan elk apart. Dit is een
 * **voorstel**, geen antwoord: de adviseur ziet het aangevinkt staan en corrigeert.
 */
export function prefillTrainingActor(
  acteuraantal: number | null,
  linkedActorCount: number
): boolean {
  return (acteuraantal !== null && acteuraantal > 0) || linkedActorCount > 0;
}

/** Zichtbare regel wanneer de geneste alinea naar een kopje verwijst dat niet is aangevinkt. */
function danglingHomeworkReference(): string {
  return notDecided(
    'verwijzing naar het kopje Huiswerkopdracht',
    'de geneste cyclusalinea verwijst ernaar, maar de huiswerkopdracht staat niet aan'
  );
}

/**
 * De vragen die de adviseur beantwoordt vóór het genereren.
 *
 * Alles is `boolean` en niets is optioneel: "niet beantwoord" bestaat niet: de adviseur
 * loopt de checklist langs en elk antwoord is expliciet. `null` zou hier stilzwijgend als
 * "nee" gelezen worden en dan verdwijnt een blok zonder dat iemand het merkt.
 */
export interface BriefingChecklist {
  /** Meerdere trainers, elk op een eigen groep. Sluit `sameGroup` uit. */
  readonly ownGroup: boolean;
  /** Meerdere trainers samen op één groep. Sluit `ownGroup` uit. */
  readonly sameGroup: boolean;
  readonly trainingCycle: boolean;
  readonly homework: boolean;
  readonly preparatoryAssignment: boolean;
  /**
   * Werkt er een trainingsacteur mee? Een eigen checklistvraag, zoals `06-briefing.md` hem
   * ook stelt, en niet af te leiden uit Monday.
   *
   * `Acteuraantal` staat op 264 van de 815 trainingen leeg, en leeg is niet nul. Die kolom
   * als antwoord gebruiken laat het acteurblok bij precies die 264 stilzwijgend weg. Monday
   * mag dit vinkje dus wél **voorinvullen** — zie `prefillTrainingActor` — maar de adviseur
   * bevestigt het.
   */
  readonly trainingActor: boolean;
}

/** Alles op nee: de basis waar de checklist bovenop komt. */
export const EMPTY_CHECKLIST: BriefingChecklist = {
  ownGroup: false,
  sameGroup: false,
  trainingCycle: false,
  homework: false,
  preparatoryAssignment: false,
  trainingActor: false,
};

const OWN_GROUP: BriefingBlock = {
  titel: 'Ieder een eigen groep',
  regels: [
    'Elke trainer traint een eigen groep. Het is belangrijk dat dit zo veel mogelijk op ' +
      'dezelfde manier gebeurt. Gebruik bijvoorbeeld dezelfde opzet en (soort) werkvormen.',
  ],
};

const SAME_GROUP: BriefingBlock = {
  titel: 'Lead- en co-trainer(s) op dezelfde groep',
  regels: [
    'Jullie trainen samen de gehele groep, deze wordt dus niet opgesplitst over meerdere ' +
      'locaties. Zorg daarom voor een goede afstemming. Houd er rekening mee dat de klant ' +
      'extra betaalt voor de co-trainer(s). Het is daarom belangrijk dat alle trainers een ' +
      'actieve en duidelijke rol hebben tijdens de sessie(s).',
  ],
};

/**
 * De vier alinea's van het cyclusblok, waarvan de tweede **genest** is.
 *
 * `06-briefing.md` beschrijft die nesting bij de checklistvraag over de voorbereidende
 * opdracht: *"Ja → tekstblok. **En dan komt de cyclus-tekst er ook bij** (geneste regel)"*,
 * en de acceptatiecriteria vragen om precies dat verschil te kunnen aantonen:
 *
 * > 2. Genereer een briefing met een trainingscyclus **én** een voorbereidende opdracht. De
 * >    geneste alinea verschijnt en de afbeelding staat goed.
 * > 3. Genereer dezelfde briefing zonder de voorbereidende opdracht. Die alinea is weg.
 *
 * Alinea 2 is de enige die over een voorbereidende opdracht gaat, dus dat is de geneste. Een
 * cyclus zónder voorbereidende opdracht is dus een geldige, in de acceptatiecriteria
 * gevraagde toestand, en niet iets om te weigeren.
 */
const CYCLE_INTRO =
  'Deze opdracht betreft een trainingscyclus van meerdere, op elkaar verdiepende sessies. ' +
  'Hierdoor komen deelnemers meerdere keren in contact met de lesstof. Dit heeft een grote ' +
  'positieve invloed op het leerrendement.';

/** De geneste alinea: staat er alleen bij een voorbereidende opdracht. */
const CYCLE_NESTED =
  'Vóór de eerste sessie ontvangen deelnemers een voorbereidende reflectieopdracht. Tussen ' +
  'de sessies zit een oefen- en integratieperiode (meestal van zo’n 2 à 3 weken), waarin ' +
  'deelnemers bezig zijn met een huiswerkopdracht. Voor instructies over de huiswerkopdracht, ' +
  'zie kopje ‘Huiswerkopdracht’.';

const CYCLE_NEXT_STEP =
  'Aan het einde van elke sessie, of tijdens de laatste sessie definiëren deelnemers hun eigen ' +
  'Next Step. Dit is een concrete vervolgstap waar ze na de training zelfstandig mee verder ' +
  'kunnen. Deze Next Step kan eventueel worden opgenomen in de ontwikkelgesprekken tussen ' +
  'manager en medewerker.';

const CYCLE_DIAGRAM_INTRO =
  'Grofweg zie de cyclus ziet er als onderstaand uit. Het betreft in dit voorbeeld een cyclus ' +
  'van 2 x 4 uur, maar we hebben soms ook cycli van meerdere of langere sessies. Hieronder ' +
  'staat een grove opzet qua programma, maar meestal zijn er inhoudelijk al meer kaders ' +
  'gegeven (als dat zo is, vind je die in deze briefing).';

/**
 * Het cyclusblok, met of zonder de geneste alinea.
 *
 * De geneste alinea verwijst óók naar het kopje `Huiswerkopdracht`. Staat die alinea erin
 * terwijl de huiswerkopdracht níet is aangevinkt, dan verwijst de briefing naar een kopje dat
 * er niet is. Dat is geen reden om te weigeren — `06-briefing.md` zegt uitdrukkelijk dat de
 * huiswerkopdracht *"apart aanvinken"* is — maar het moet wel zichtbaar zijn, want de trainer
 * gaat anders zoeken naar instructies die nergens staan.
 */
function trainingCycleBlock(checklist: BriefingChecklist): BriefingBlock {
  const regels: string[] = [CYCLE_INTRO];
  if (checklist.preparatoryAssignment) {
    regels.push(CYCLE_NESTED);
    if (!checklist.homework) {
      regels.push(danglingHomeworkReference());
    }
  }
  regels.push(CYCLE_NEXT_STEP, CYCLE_DIAGRAM_INTRO);
  return { titel: 'Trainings/workshop/teambuilding cyclus', regels, afbeelding: CYCLE_DIAGRAM };
}

const HOMEWORK: BriefingBlock = {
  titel: 'Huiswerkopdracht',
  regels: [
    'In overeenstemming met de klant verzorgen wij een huiswerkopdracht voor de deelnemers. Jij ' +
      'geeft deze vorm, afgestemd op de opdracht en groep. Denk alsjeblieft aan de volgende zaken:',
    'De opdracht dient deelnemers te helpen om de inhoud van de training direct in de praktijk toe ' +
      'te passen, inzichten op te doen en eventuele knelpunten of vragen zichtbaar te maken.',
    'Zorg er zo veel mogelijk voor dat de opdracht als onderdeel van het werk kan worden ' +
      'uitgevoerd, in plaats van dat het de deelnemers extra tijd kost.',
    'Is de huiswerkopdracht niet onderdeel van een trainingscyclus (dus meerdere opvolgende ' +
      'sessies vanuit ons)? Spreek dan met de groep af of en hoe ze de uitvoer van de opdracht ' +
      'borgen.',
  ],
};

const PREPARATORY_ASSIGNMENT: BriefingBlock = {
  titel: 'Voorbereidende opdracht',
  regels: [
    'Voor deze opdracht werken we met een voorbereidende opdracht, zodat jij vooraf meer inzicht ' +
      'krijgt in de situatie en leerdoelen van de deelnemers.',
    'Ook kunnen de antwoorden inzicht geven of je aan het begin van de sessie de verwachtingen van ' +
      'de deelnemers moet managen, omdat er bijvoorbeeld te uiteenlopende verwachtingen zijn van de ' +
      'sessie. Mocht dit laatste gebeuren, laat mij dit dan alsjeblieft weten, zodat ik het met de ' +
      'contactpersoon kan bespreken.',
    'In de bijlage van de mail vind je een template met voorbeeldvragen. Zou je deze willen ' +
      'aanpassen zodat deze aansluit op jouw sessie en vervolgens met mij delen? Dan zorg ik ervoor ' +
      'dat deze bij de klant terechtkomt.',
  ],
};

/** De inleidende zin van het `Vaste klant`-blok; de tabel komt eronder. */
const RECURRING_CLIENT_INTRO =
  'Voor deze klant hebben we meerdere sessies georganiseerd staan (verleden en/of toekomst). Zie ' +
  'hieronder een overzicht van de sessies die zijn geweest en/of nog gepland staan, inclusief alle ' +
  'informatie die wij ervoor hebben.';

/** Eén eerdere of komende sessie bij dezelfde klant. */
export interface HistoryRow {
  readonly datum: string;
  readonly tijd: string;
  readonly klanttitel: string;
  readonly trainer: string;
  readonly contactpersoon: string;
}

/**
 * Het `Vaste klant`-blok.
 *
 * Drie uitkomsten, en het verschil tussen de eerste twee is precies waar dit blok voor
 * bestaat:
 *
 * | `regels` | Resultaat |
 * |---|---|
 * | `undefined` | een blok met een zichtbare openstaande regel — de historie is nog niet aangesloten |
 * | `[]` | `null`, geen blok — er zijn écht geen andere sessies bij deze klant |
 * | gevuld | het blok met de tabel |
 *
 * Die eerste twee samennemen zou betekenen dat elke briefing die wij nu maken de sectie
 * stilzwijgend weglaat en er compleet uitziet. Een trainer die bij een vaste klant staat
 * krijgt dan geen enkel signaal dat er meer sessies zijn.
 *
 * LET OP: ITG's bronbestand zegt hier `*** INVOEGEN *** Tabel met onderstaande kolommen`,
 * dus dit hoort een échte tabel te zijn. Het sjabloon kent binnen een blok alleen alinea's,
 * dus tot het sjabloon een tabel krijgt staan de regels hier als tekst onder elkaar. Dat is
 * zichtbaar anders dan bedoeld, en dat is beter dan stilletjes de helft weglaten.
 */
export function recurringClientBlock(rows: readonly HistoryRow[] | undefined): BriefingBlock | null {
  if (rows === undefined) {
    return {
      titel: 'Vaste klant',
      regels: [
        notConnected(
          'eerdere en komende sessies bij deze klant',
          'de agendaborden van meerdere jaargangen'
        ),
      ],
    };
  }
  if (rows.length === 0) {
    return null;
  }
  return { titel: 'Vaste klant', regels: [RECURRING_CLIENT_INTRO], historie: rows };
}

/**
 * De blokken die er hóren te staan maar die wij nog niet kunnen invullen.
 *
 * `06-briefing.md` maakt ze verplicht: bij meerdere trainers hoort `Leadtrainer` of
 * `Co-trainer`, en bij een trainingsacteur `Werken met een trainingsacteur` of `Werken als
 * trainingsacteur`. Beide bestaan in **twee varianten** en welke iemand moet lezen hangt af
 * van zijn rol in die sessie. Monday legt die rol nergens vast, dus wij kunnen niet kiezen.
 *
 * Ze daarom weglaten zou een briefing opleveren waarin een co-trainer nergens leest dat er
 * een lead is, en waarin een acteur nergens leest wat er van hem verwacht wordt — zonder dat
 * iets erop wijst dat er iets ontbreekt. Er komt dus een zichtbaar blok in het document.
 */
function roleBlocks(checklist: BriefingChecklist, session: SessionFacts): BriefingBlock[] {
  const blocks: BriefingBlock[] = [];

  if (session.certainTrainers > 1) {
    blocks.push({
      titel: 'Leadtrainer / Co-trainer',
      regels: [
        notConnected(
          `de rolteksten voor ${session.certainTrainers} trainers`,
          'welke trainer lead is en welke co; twee varianten, nog niet belegd'
        ),
      ],
    });
  } else if (maxTrainers(session) > 1) {
    /**
     * Het kán een co-trainer zijn en het kán een acteur zijn, en wij weten het niet. Het blok
     * stellig plaatsen kondigt een co-trainer aan die er misschien niet is; het weglaten laat
     * een echte co-trainer verdwijnen. Dus zeggen dat het onbekend is.
     */
    blocks.push({
      titel: 'Rolverdeling onduidelijk',
      regels: [
        notDecided(
          `de rol van ${session.unknownRole} gekoppelde perso(o)n(en)`,
          'Acteuraantal belooft meer acteurs dan er in de groep Acteurs te vinden zijn, dus of ' +
            'dit een co-trainer of een acteur is, staat nergens'
        ),
      ],
    });
  }

  if (checklist.trainingActor) {
    const wie =
      session.identifiedActors > 0
        ? `${session.identifiedActors} herkende acteur(s)`
        : 'geen enkele gekoppelde persoon staat in de groep Acteurs';
    blocks.push({
      titel: 'Trainingsacteur',
      regels: [
        notConnected(
          `de acteurteksten (${wie})`,
          'of de ontvanger de trainer of de acteur zelf is; twee varianten, nog niet belegd'
        ),
      ],
    });
  }
  return blocks;
}

/**
 * De blokken die bij deze training horen, in de volgorde van het bronbestand.
 *
 * `historie` mag `undefined` zijn: dat betekent "nog niet aangesloten" en levert een
 * zichtbaar blok op, terwijl `[]` betekent "gecontroleerd, deze klant heeft geen andere
 * sessies" en niets oplevert.
 *
 * Eén combinatie wordt geweigerd: `ownGroup` én `sameGroup` samen. Dat zijn de twee
 * antwoorden op één vraag, en zelf kiezen zou de briefing stellig het verkeerde laten
 * beweren over hoe de groep wordt opgesplitst.
 *
 * Verder wordt hier niets geweigerd. De vinkjes zijn volgens `06-briefing.md` bewust
 * onafhankelijk — de huiswerkopdracht is *"apart aanvinken"* — en een cyclus zónder
 * voorbereidende opdracht is zelfs een van de acceptatiecriteria. Wat er scheef aan kan zijn,
 * zoals een verwijzing naar een kopje dat niet is aangevinkt, komt zichtbaar in het document
 * te staan in plaats van het genereren tegen te houden.
 *
 * **Openstaande vraag aan Dirkje.** `06-briefing.md` schrijft bij de voorbereidende opdracht
 * *"En dan komt de cyclus-tekst er ook bij (geneste regel)"*. Dat kan twee dingen betekenen:
 * alleen de geneste alinea (zo staat het hier), of het hele cyclusblok, ook als de cyclus
 * zelf niet is aangevinkt. De acceptatiecriteria beschrijven alleen het eerste, dus dat is
 * gebouwd; het tweede zou een blok toevoegen dat de adviseur niet heeft aangevinkt.
 */
export function selectBlocks(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  session: SessionFacts
): BriefingBlock[] {
  if (checklist.ownGroup && checklist.sameGroup) {
    throw new Error(
      'Briefing: "ieder een eigen groep" en "lead- en co-trainer(s) op dezelfde groep" kunnen ' +
        'niet allebei aanstaan; dit zijn de twee antwoorden op dezelfde vraag.'
    );
  }
  const blocks: BriefingBlock[] = [...roleBlocks(checklist, session)];
  if (checklist.ownGroup) {
    blocks.push(OWN_GROUP);
  }
  if (checklist.sameGroup) {
    blocks.push(SAME_GROUP);
  }
  const recurring = recurringClientBlock(historie);
  if (recurring !== null) {
    blocks.push(recurring);
  }
  if (checklist.trainingCycle) {
    blocks.push(trainingCycleBlock(checklist));
  }
  if (checklist.homework) {
    blocks.push(HOMEWORK);
  }
  if (checklist.preparatoryAssignment) {
    blocks.push(PREPARATORY_ASSIGNMENT);
  }
  return blocks;
}
