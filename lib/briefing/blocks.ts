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
 * ## De rolafhankelijke blokken
 *
 * `Leadtrainer` versus `Co-trainer`, en `Werken met een trainingsacteur` versus `Werken als
 * trainingsacteur`. Ze stonden hier lang niet in, omdat één briefing naar álle trainers ging
 * en Monday nergens vastlegde wie de lead was. Sinds 21-Aug-2026 is dat wél zo — de
 * co-trainerkolom — en gaat er één document per ontvanger uit. Zie `recipientBlocks`.
 *
 * Zonder ontvanger blijft `roleBlocks` de zichtbare `«…»`-variant leveren: samenstellen
 * zonder te weten voor wie is een geldige tussenstap, en gokken is dat niet.
 */

import { notConnected, notDecided } from './open-issues';

import { nameList } from './recipients';

import type { Recipient } from './recipients';

/**
 * Eén blok zoals het sjabloon het invult: een kop, alinea's, en soms een afbeelding.
 *
 * `titel`, `regels` en `afbeelding` zijn Nederlands omdat het de veldnamen zijn die
 * lettterlijk in de negen `.docx`-sjablonen staan (`+++$blk.titel+++`,
 * `+++FOR r IN $blk.regels+++`). Hernoemen breekt het renderen zonder dat iets faalt.
 */
/**
 * Eén regel van een blok, met de opmaak die ITG's bron hem geeft.
 *
 * Een blok is geen lijst óf een lopende tekst maar allebei: het leadblok opent met een zin
 * en gaat dan over in vier opsommingsregels. Gemeten over `ITG Briefingteksten bij
 * bijzonderheden.docx`: 36 alinea's met een opsommingsteken, 66 zonder, door elkaar binnen
 * hetzelfde blok. Eén vlag voor het hele blok kan dat dus niet uitdrukken.
 */
export interface BlockLine {
  readonly tekst: string;
  readonly bullet: boolean;
}

/** Een gewone alinea. */
const prose = (tekst: string): BlockLine => ({ tekst, bullet: false });
/** Een opsommingsregel. */
const bullet = (tekst: string): BlockLine => ({ tekst, bullet: true });
const bullets = (...regels: readonly string[]): BlockLine[] => regels.map(bullet);

export interface BriefingBlock {
  readonly titel: string;
  readonly regels: readonly BlockLine[];
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
 * De vier rolafhankelijke teksten, uit `ITG Briefingteksten bij bijzonderheden.docx`.
 *
 * Twee paren, en binnen elk paar beweren de varianten het **tegenovergestelde** over wie het
 * klantcontact doet. De verkeerde variant sturen is daarom geen schoonheidsfoutje: dan leest
 * een co-trainer dat híj de klant belt terwijl de lead dat ook denkt, of leest niemand het.
 *
 * De alinea's staan hier **exact zoals ITG ze schreef**, inclusief hun plaatshouder
 * `Naam (tel nr)` en inclusief het ontbrekende spatie na de punt. Dat is met opzet: zo kan
 * `verify-blocks.py` juist de zinnen die ertoe doen letterlijk vergelijken met hun document.
 * De namen worden er bij het samenstellen ingezet.
 *
 * **Twee typefouten zijn wél gecorrigeerd**, omdat `06-briefing.md` dat uitdrukkelijk
 * voorschrijft: *"in de brontekst staan twee typefouten (`Kantcontact` in plaats van
 * Klantcontact, en `trainingscacteur`). Neem ze **niet** over — meld ze aan Dirkje en gebruik
 * de correcte spelling."* Ze staan als bewuste afwijking in `CORRECTIONS` in de verifier, dus
 * ze blijven bewaakt in plaats van een gat te slaan.
 */

/** ITG's eigen plaatshouder voor meerdere personen, letterlijk uit hun bronbestand. */
const TWO_NAMES = 'Naam (tel nr), Naam (tel nr)';
/** Idem voor één persoon. */
const ONE_NAME = 'Naam (tel nr)';

/**
 * De `\n` is ITG's eigen regelafbreking, geen opmaakkeuze van ons.
 *
 * In `ITG Briefingteksten bij bijzonderheden.docx` staat in deze alinea's een echte
 * `<w:br/>`: na "Naam (tel nr)." en na "co-trainer(s)". Bij het overnemen naar dit bestand
 * zijn die weggevallen, en dan plakt de tekst aan elkaar — "co-trainer(s)Alle trainers" en
 * "(06-14884896).Jij bent". Gezien in een gegenereerde briefing, 24-Aug-2026.
 *
 * `docx-templates` zet `\n` om in een `<w:br/>` (`processLineBreaks`, standaard aan), dus
 * dit levert exact ITG's alinea op. `verify-blocks.py` leest de bron nu ook mét die
 * afbrekingen, zodat de vergelijking blijft kloppen in plaats van er omheen te werken.
 */
const LEAD_INTRO =
  'Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: Naam (tel nr), ' +
  'Naam (tel nr).\nJij bent de leadtrainer en dus verantwoordelijk voor:';

const CO_INTRO =
  'Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: Naam (tel nr), ' +
  'Naam (tel nr).\nJij bent ingedeeld als co-trainer. De leadtrainer is verantwoordelijk voor:';

const LEAD_ALIGN =
  'Afstemmen met de co-trainer(s)\nAlle trainers (jij en de co-trainers) krijgen deze briefing, ' +
  'maar jij bent verantwoordelijk voor het duidelijk briefen van de trainers over de ' +
  'definitieve opzet en uitvoering van de training.';

const CO_ALIGN =
  'Afstemmen met de co-trainer(s)\nAlle trainers (jij en de lead trainer) krijgen deze briefing, ' +
  'maar de lead trainer is verantwoordelijk voor het duidelijk briefen van de co-trainer(s) ' +
  'over de definitieve opzet en uitvoering van de training.';

const WITH_ACTOR_INTRO =
  'Voor deze opdracht werk je met een trainingsacteur: Naam (tel nr). Om een zo hoog mogelijk ' +
  'leerrendement te realiseren is er een duidelijke taakverdeling binnen de samenwerking met ' +
  'de (lead) trainer en trainingsacteur.';

const AS_ACTOR_INTRO =
  'Voor deze opdracht word je ingezet als trainingsacteur, naast de (lead) trainer: ' +
  'Naam (tel nr). Om een zo hoog mogelijk leerrendement te realiseren is er een duidelijke ' +
  'taakverdeling binnen de samenwerking met de (lead) trainer en trainingsacteur.';

/**
 * Staat in álle vier de blokken. Eén constante en geen vier kopieën, want een gedupliceerde
 * regel verstopt een wijziging: `verify-blocks.py` vraagt of er *een* alinea met deze tekst
 * bestaat, dus met twee kopieën blijft één gewijzigde kopie onzichtbaar. Gemeten.
 *
 * `Klantcontact` is hier de **gecorrigeerde** spelling; ITG's bron schrijft in de
 * acteurblokken `Kantcontact`. Zie `CORRECTIONS` in de verifier.
 */
const CLIENT_CONTACT = 'Klantcontact vooraf via Teams/telefonisch';

/**
 * De waarschuwing die beide acteurblokken openen. Lopende tekst en geen opsommingsregel:
 * zo staat hij in ITG's bron, en hij hoort ook niet in het rijtje taken eronder.
 */
const ACTOR_IMPORTANT =
  'Belangrijk: de trainingsacteur is geen co-trainer of inhoudsdeskundige, tenzij dit ' +
  'specifiek is afgesproken. De trainer blijft eindverantwoordelijk.';

/** Gedeeld door beide acteurblokken; bij ITG allemaal opsommingsregels. */
const ACTOR_SHARED: readonly string[] = [
  'De (lead) trainer is verantwoordelijk voor',
  CLIENT_CONTACT,
  'Ontwikkelen van inhoud van de training',
  'Afstemmen met de trainingsacteur en evt. co-trainer(s) over de definitieve opzet en ' +
    'uitvoering van de training',
  'De aansturing van de inzet van de acteur, inclusief duidelijke instructies over het ' +
    'gewenste gedrag of de context waarin de acteur acteert',
];

const ACTOR_TASKS: readonly string[] = [
  'Het tot leven brengen van de praktijk',
  'Het afstemmen van zijn/haar spel op het niveau van de deelnemer & het leerdoel. Dit ' +
    'gebeurt in overleg met de trainer, al dan niet op aanvraag van de deelnemer',
];

const LEAD_DUTIES: readonly string[] = [CLIENT_CONTACT, 'Ontwikkelen van training'];

const LEAD_CLOSING = 'De terugkoppeling en nabespreking met de klant en mij';

/** De tekst voor de ontvanger die leadtrainer is. */
function leadTrainerBlock(anderen: string): BriefingBlock {
  return {
    titel: 'Leadtrainer',
    regels: [
      prose(LEAD_INTRO.replace(TWO_NAMES, anderen)),
      ...bullets(...LEAD_DUTIES, LEAD_ALIGN, LEAD_CLOSING),
    ],
  };
}

/** De tekst voor de ontvanger die co-trainer is. */
function coTrainerBlock(anderen: string): BriefingBlock {
  return {
    titel: 'Co-trainer',
    regels: [
      prose(CO_INTRO.replace(TWO_NAMES, anderen)),
      ...bullets(...LEAD_DUTIES, CO_ALIGN, LEAD_CLOSING),
      // Bij ITG geen opsommingsregel: het is een afsluitende zin, geen taak in het rijtje.
      prose('Als je wilt, kun je alvast contact opnemen met de leadtrainer.'),
    ],
  };
}

/** De tekst voor een trainer die mét een acteur werkt. */
function withActorBlock(acteurs: string): BriefingBlock {
  return {
    titel: 'Werken met een trainingsacteur',
    regels: [
      prose(WITH_ACTOR_INTRO.replace(ONE_NAME, acteurs)),
      prose(ACTOR_IMPORTANT),
      ...bullets(
        ...ACTOR_SHARED,
        'De trainingsacteur is verantwoordelijk het',
        ...ACTOR_TASKS,
        'Geven van feedback vanuit de rol (o.b.v. gedrag) én als observator (verbaal)'
      ),
    ],
  };
}

/** De tekst voor de ontvanger die zélf de acteur is. */
function asActorBlock(trainers: string): BriefingBlock {
  return {
    titel: 'Werken als trainingsacteur',
    regels: [
      prose(AS_ACTOR_INTRO.replace(ONE_NAME, trainers)),
      prose(ACTOR_IMPORTANT),
      ...bullets(
        ...ACTOR_SHARED,
        'De trainingsacteur is verantwoordelijk voor',
        ...ACTOR_TASKS,
        'Het geven van feedback vanuit de rol (o.b.v. gedrag) én als observator (verbaal)'
      ),
    ],
  };
}

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
  /**
   * De concept-inhoud zoals de adviseur hem heeft achtergelaten, of `undefined` als hij
   * hem niet heeft aangeraakt.
   *
   * **Alleen opslaan als er echt getypt is.** Onaangeraakt betekent "gebruik het skelet van
   * het thema", en dan bereikt een verbeterd skelet elke volgende briefing. Zouden wij het
   * skelet bij het openen van de tab meteen wegschrijven, dan bevriest elke training een
   * kopie op de dag dat iemand hem toevallig opendeed.
   *
   * Het staat hier en niet in `BriefingExtras` omdat het een antwoord van de adviseur is,
   * net als de vinkjes: `06-briefing.md` stelt het als checklistvraag *"Standaard
   * bulletpoints (conceptprogramma)? ja/nee → Nee, tekstveld, de adviseur typt zelf"*.
   * Eén tekstveld beantwoordt die vraag: leeg is ja, gevuld is nee.
   */
  readonly conceptInhoud?: string;
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
    prose(
      'Elke trainer traint een eigen groep. Het is belangrijk dat dit zo veel mogelijk op ' +
        'dezelfde manier gebeurt. Gebruik bijvoorbeeld dezelfde opzet en (soort) werkvormen.'
    ),
  ],
};

const SAME_GROUP: BriefingBlock = {
  titel: 'Lead- en co-trainer(s) op dezelfde groep',
  regels: [
    prose(
      'Jullie trainen samen de gehele groep, deze wordt dus niet opgesplitst over meerdere ' +
        'locaties. Zorg daarom voor een goede afstemming. Houd er rekening mee dat de klant ' +
        'extra betaalt voor de co-trainer(s). Het is daarom belangrijk dat alle trainers een ' +
        'actieve en duidelijke rol hebben tijdens de sessie(s).'
    ),
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
  return {
    titel: 'Trainings/workshop/teambuilding cyclus',
    regels: regels.map(prose),
    afbeelding: CYCLE_DIAGRAM,
  };
}

const HOMEWORK: BriefingBlock = {
  titel: 'Huiswerkopdracht',
  regels: [
    prose(
      'In overeenstemming met de klant verzorgen wij een huiswerkopdracht voor de deelnemers. Jij ' +
        'geeft deze vorm, afgestemd op de opdracht en groep. Denk alsjeblieft aan de volgende zaken:'
    ),
    ...bullets(
      'De opdracht dient deelnemers te helpen om de inhoud van de training direct in de praktijk toe ' +
        'te passen, inzichten op te doen en eventuele knelpunten of vragen zichtbaar te maken.',
      'Zorg er zo veel mogelijk voor dat de opdracht als onderdeel van het werk kan worden ' +
        'uitgevoerd, in plaats van dat het de deelnemers extra tijd kost.',
      'Is de huiswerkopdracht niet onderdeel van een trainingscyclus (dus meerdere opvolgende ' +
        'sessies vanuit ons)? Spreek dan met de groep af of en hoe ze de uitvoer van de opdracht ' +
        'borgen.'
    ),
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
  ].map(prose),
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
export function recurringClientBlock(
  rows: readonly HistoryRow[] | undefined
): BriefingBlock | null {
  if (rows === undefined) {
    return {
      titel: 'Vaste klant',
      regels: [
        notConnected(
          'eerdere en komende sessies bij deze klant',
          'de agendaborden van meerdere jaargangen'
        ),
      ].map(prose),
    };
  }
  if (rows.length === 0) {
    return null;
  }
  return { titel: 'Vaste klant', regels: [prose(RECURRING_CLIENT_INTRO)], historie: rows };
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
/**
 * De rolblokken voor één ontvanger, nu de rol een feit van het bord is.
 *
 * Vier teksten, twee paren, en binnen elk paar het tegenovergestelde over wie het
 * klantcontact doet. Welke iemand krijgt volgt uit zijn rol plus de samenstelling van de
 * sessie:
 *
 * | Ontvanger | Blokken |
 * |---|---|
 * | lead, met andere trainers | `Leadtrainer` |
 * | co-trainer | `Co-trainer` |
 * | trainer op een sessie mét acteur | **plus** `Werken met een trainingsacteur` |
 * | de acteur zelf | `Werken als trainingsacteur` |
 * | enige trainer, geen acteur | geen — er valt niets af te stemmen |
 *
 * Het lead/co-paar komt er alleen bij **twee of meer trainers**, want de tekst opent met
 * *"Naast jou zijn er ook andere trainers ingedeeld op deze opdracht"*. Een acteur is geen
 * trainer, dus één trainer plus een acteur krijgt alléén het acteurblok.
 *
 * Een trainer op een sessie mét acteur krijgt er **twee**: zijn eigen lead- of co-tekst en
 * het acteurblok. Zo staat het in ITG's bronbestand, waar het twee losse kopjes zijn.
 */
export function recipientBlocks(
  recipient: Recipient,
  checklist: BriefingChecklist,
  format: (naam: string, telefoon: string) => string
): BriefingBlock[] {
  if (recipient.role === 'acteur') {
    return [asActorBlock(nameList(recipient.otherTrainers, format))];
  }

  const blocks: BriefingBlock[] = [];
  if (recipient.otherTrainers.length > 0) {
    const anderen = nameList(recipient.otherTrainers, format);
    blocks.push(recipient.role === 'lead' ? leadTrainerBlock(anderen) : coTrainerBlock(anderen));
  }

  if (checklist.trainingActor) {
    if (recipient.actors.length === 0) {
      /**
       * De adviseur zegt dat er een acteur meewerkt, maar er is er geen aan te wijzen. Het
       * blok noemt de acteur bij naam, dus het stellig plaatsen zou een lege naam opleveren.
       */
      blocks.push({
        titel: 'Werken met een trainingsacteur',
        regels: [
          notDecided(
            'wie de trainingsacteur is',
            'de acteurvraag staat op ja, maar geen enkele gekoppelde persoon staat in de ' +
              'groep Acteurs en er is er ook geen aangewezen'
          ),
        ].map(prose),
      });
    } else {
      blocks.push(withActorBlock(nameList(recipient.actors, format)));
    }
  }
  return blocks;
}

/**
 * De rolblokken zónder ontvanger: wat er in het document komt als de aanroeper niet zegt
 * voor wie het is.
 *
 * Blijft bestaan omdat een briefing samenstellen zonder ontvanger een geldige tussenstap is
 * — de adviseur die in de app-tab kijkt wat er in het document zou komen, bijvoorbeeld. Er
 * komt dan een zichtbare `«…»`-regel in plaats van een gok, want de twee varianten spreken
 * elkaar tegen.
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
      ].map(prose),
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
      ].map(prose),
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
      ].map(prose),
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
/**
 * Dezelfde blokken, maar gesplitst in de rolblokken en de rest.
 *
 * De rolblokken staan in het document bóven `Concept inhoud`; alle andere blokken staan
 * eronder. `selectBlocks` blijft de platte lijst geven, want die volgorde is nog steeds de
 * volgorde waarin de blokken gekozen worden.
 */
export function splitBlocks(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  session: SessionFacts,
  recipient?: {
    readonly recipient: Recipient;
    readonly format: (naam: string, telefoon: string) => string;
  }
): { readonly rolblokken: BriefingBlock[]; readonly blokken: BriefingBlock[] } {
  const alle = selectBlocks(checklist, historie, session, recipient);
  const rol = new Set<string>(rolBlockTitels(checklist, session, recipient));
  return {
    rolblokken: alle.filter((b) => rol.has(b.titel)),
    blokken: alle.filter((b) => !rol.has(b.titel)),
  };
}

/** De titels die `selectBlocks` als rolblok toevoegt, in dezelfde tak als daar. */
function rolBlockTitels(
  checklist: BriefingChecklist,
  session: SessionFacts,
  recipient?: {
    readonly recipient: Recipient;
    readonly format: (naam: string, telefoon: string) => string;
  }
): string[] {
  const blokken =
    recipient === undefined
      ? roleBlocks(checklist, session)
      : recipientBlocks(recipient.recipient, checklist, recipient.format);
  return blokken.map((b) => b.titel);
}

export function selectBlocks(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  session: SessionFacts,
  /**
   * Voor wie dit document is, als de aanroeper dat weet. Zonder ontvanger komen de
   * rolblokken als zichtbare `«…»`-regel in plaats van als gok.
   */
  recipient?: {
    readonly recipient: Recipient;
    readonly format: (naam: string, telefoon: string) => string;
  }
): BriefingBlock[] {
  if (checklist.ownGroup && checklist.sameGroup) {
    throw new Error(
      'Briefing: "ieder een eigen groep" en "lead- en co-trainer(s) op dezelfde groep" kunnen ' +
        'niet allebei aanstaan; dit zijn de twee antwoorden op dezelfde vraag.'
    );
  }
  const blocks: BriefingBlock[] =
    recipient === undefined
      ? [...roleBlocks(checklist, session)]
      : [...recipientBlocks(recipient.recipient, checklist, recipient.format)];
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
  /**
   * Huiswerk en de voorbereidende opdracht gaan over het MAKEN van de inhoud, dus niet naar
   * de acteur.
   *
   * ITG's brontekst zegt dat op drie plekken. Het acteurblok: de trainingsacteur is *"geen
   * co-trainer of inhoudsdeskundige"*, en **"Ontwikkelen van inhoud van de training"** staat
   * onder de verantwoordelijkheden van de trainer. Het huiswerkblok: *"Jij geeft deze vorm,
   * afgestemd op de opdracht en groep"*. De voorbereidende opdracht: *"Zou je deze willen
   * aanpassen zodat deze aansluit op jouw sessie en vervolgens met mij delen?"*
   *
   * Zonder ontvanger blijven ze staan: dat is de voorbeeldweergave, geen document voor een
   * bepaald persoon, en daar hoort te zien te zijn wat de checklist aanzet.
   */
  const naarMaker = recipient === undefined || recipient.recipient.role !== 'acteur';
  if (checklist.homework && naarMaker) {
    blocks.push(HOMEWORK);
  }
  if (checklist.preparatoryAssignment && naarMaker) {
    blocks.push(PREPARATORY_ASSIGNMENT);
  }
  return blocks;
}
