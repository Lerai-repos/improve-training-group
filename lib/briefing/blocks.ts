/**
 * De conditionele blokken: welke erin komen, en met welke tekst.
 *
 * **Wélke** blokken erin komen beslist dit bestand. **Wat** er staat beslist ITG, op het bord
 * Briefingteksten (sinds 30-Sep-2026; zie `@lib/briefingteksten`). De teksten die hier eerder
 * letterlijk stonden, uit `ITG Briefingteksten bij bijzonderheden.docx`, zijn de beginwaarden
 * van dat bord geworden en staan nu in `lib/briefingteksten/catalog.ts`.
 *
 * Een sectie die ITG leeg laat verdwijnt uit het document; een sectie met een fout erin wordt
 * een zichtbare `«…»`-regel. De blokkeuze zelf verandert daar niet door.
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

import { aantalWoord, type CyclusFeiten } from './cyclus-document';
import { notConnected, notDecided } from './open-issues';
import { gevuldeSectie, standaardTekstenVoor, type Waarden } from './teksten';

import { nameList } from './recipients';

import type { BriefingTeksten, TekstSleutel } from '@lib/briefingteksten/types';
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
  /**
   * Het inspringniveau van de opsomming: `0` of `1`.
   *
   * Alleen de acteurblokken gebruiken niveau 1. Gemeten in ITG's bronbestand: de twee regels
   * "… is verantwoordelijk voor" staan op `ilvl=0` en hun taken op `ilvl=1`, terwijl in het
   * lead- en co-trainerblok álles op `ilvl=0` staat. Vlak weergeven maakte van de twee
   * koppen gewone taken, en dan lees je "Ontwikkelen van inhoud" als iets van de acteur.
   */
  readonly niveau: 0 | 1;
}

/** Een gewone alinea; voor de `«…»`-regels die niet van het bord komen. */
const prose = (tekst: string): BlockLine => ({ tekst, bullet: false, niveau: 0 });

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
 * Een blok uit één sectie van het bord, of `null` als ITG hem leeg liet.
 *
 * De kop van de sectie wordt de titel van het blok. Een lege kop mag: dan staat de tekst er
 * zonder kop, en het sjabloon laat de kopregel weg.
 */
function sectieBlok(
  teksten: BriefingTeksten,
  sleutel: TekstSleutel,
  waarden: Waarden = {}
): BriefingBlock | null {
  const gevuld = gevuldeSectie(teksten, sleutel, waarden);
  return gevuld === null ? null : { titel: gevuld.kop, regels: gevuld.regels };
}

/** Het blok als lijst: leeg als ITG de sectie leeg liet. */
const alsLijst = (blok: BriefingBlock | null): BriefingBlock[] => (blok === null ? [] : [blok]);

/**
 * De vier rolafhankelijke teksten.
 *
 * Twee paren, en binnen elk paar beweren de varianten het **tegenovergestelde** over wie het
 * klantcontact doet. De verkeerde variant sturen is daarom geen schoonheidsfoutje: dan leest
 * een co-trainer dat híj de klant belt terwijl de lead dat ook denkt, of leest niemand het.
 *
 * De namen komen in `{trainers}` en `{acteurs}`, met telefoonnummer.
 */
const ROLTEKST: Readonly<Record<'lead' | 'co', TekstSleutel>> = {
  lead: 'rol.leadtrainer',
  co: 'rol.co-trainer',
};

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

/**
 * Wat er van het agendabord komt in plaats van uit de checklist.
 *
 * Tot 17-Sep-2026 waren dit vinkjes in de tab. Dirkje: de accountmanager vult ze al in bij het
 * converteren, en een werkstudent die ze bij het maken van de briefing opnieuw moet opzoeken
 * in de offerte doet dubbel werk. Ze komen nu uit `Voorb. opdr.`, `Huisw. opdr.` en
 * `DuurcategorieAG`; zie `readOpdrachten` in `read.ts`.
 */
export interface BriefingOpdrachten {
  readonly trainingCycle: boolean;
  readonly homework: boolean;
  readonly preparatoryAssignment: boolean;
}

/**
 * De vragen die de adviseur zelf beantwoordt vóór het genereren.
 *
 * Alles is `boolean` en niets is optioneel: "niet beantwoord" bestaat niet: de adviseur
 * loopt de checklist langs en elk antwoord is expliciet. `null` zou hier stilzwijgend als
 * "nee" gelezen worden en dan verdwijnt een blok zonder dat iemand het merkt.
 */
export interface BriefingAnswers {
  /** Meerdere trainers, elk op een eigen groep. Sluit `sameGroup` uit. */
  readonly ownGroup: boolean;
  /** Meerdere trainers samen op één groep. Sluit `ownGroup` uit. */
  readonly sameGroup: boolean;
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
  /**
   * De achtergrondinformatie zoals de adviseur hem in de tab heeft getypt, of `undefined` als
   * de Opportunity-tekst geldt. Zelfde regel als bij `conceptInhoud`: alleen opslaan als er
   * echt getypt is. Zie `metEigenAchtergrond`.
   */
  readonly achtergrondInhoud?: string;
}

/** Alles wat de blokken bepaalt: de antwoorden van de adviseur plus wat het agendabord zegt. */
export interface BriefingChecklist extends BriefingAnswers, BriefingOpdrachten {}

/** Alles op nee: de basis waar de checklist bovenop komt. */
export const EMPTY_CHECKLIST: BriefingChecklist = {
  ownGroup: false,
  sameGroup: false,
  trainingCycle: false,
  homework: false,
  preparatoryAssignment: false,
  trainingActor: false,
};

/**
 * Het cyclusblok, met de cijfers van déze cyclus erin.
 *
 * Vier secties van het bord onder één kop, met het cyclusschema eronder. Dirkje's formulering
 * uit haar Reade-cyclusbriefing (22-Sep-2026) is de beginwaarde: `{duur}` en `{aantal}` komen
 * uit de sessies (`cyclus-document.ts`).
 *
 * De huiswerkverwijzing en de voorbereidende opdracht staan er alleen bij als ze ook echt
 * gelden: verwijzen naar een kopje dat er niet staat stuurt de trainer het document door op
 * zoek naar niets. Een cyclus zonder voorbereidende opdracht is een gevraagde toestand
 * (`06-briefing.md`, acceptatiecriteria), geen fout.
 *
 * Is de duur niet bekend — een sessie met een Duur die niet op te tellen is — dan valt
 * "van {duur}" weg: "Bij een trainingscyclus volgt de groep twee sessies". Beter niets dan
 * een half getal, zoals de tekst dat vóór het bord ook deed.
 */
/** "van {duur}" of een losse `{duur}` weg, met de spatie ervoor. */
function zonderDuur(tekst: string): string {
  return tekst.replace(/\s*\bvan\s+\{\s*duur\s*\}/gi, '').replace(/\s*\{\s*duur\s*\}/gi, '');
}

function trainingCycleBlock(
  checklist: BriefingChecklist,
  cyclus: CyclusFeiten | null,
  teksten: BriefingTeksten
): BriefingBlock | null {
  const duur = cyclus?.duur ?? '';
  const inleiding = gevuldeSectie(
    teksten,
    'cyclus.inleiding',
    {
      duur,
      aantal: cyclus === null || cyclus.aantal < 2 ? 'meerdere' : aantalWoord(cyclus.aantal),
    },
    (tekst) => (duur === '' ? zonderDuur(tekst) : tekst)
  );
  const delen = [
    inleiding,
    checklist.homework ? gevuldeSectie(teksten, 'cyclus.huiswerk') : null,
    checklist.preparatoryAssignment ? gevuldeSectie(teksten, 'cyclus.voorbereiding') : null,
    gevuldeSectie(teksten, 'cyclus.afsluiting'),
  ];
  const regels = delen.flatMap((deel) => deel?.regels ?? []);
  if (regels.length === 0) {
    return null;
  }
  return { titel: inleiding?.kop ?? '', regels, afbeelding: CYCLE_DIAGRAM };
}

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
  rows: readonly HistoryRow[] | undefined,
  teksten: BriefingTeksten = standaardTekstenVoor('')
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
  // De tabel blijft staan als ITG de tekst leegmaakt: de sessies zijn geen tekst van hen.
  const tekst = sectieBlok(teksten, 'vaste-klant');
  return { titel: tekst?.titel ?? '', regels: tekst?.regels ?? [], historie: rows };
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
  format: (naam: string, telefoon: string) => string,
  teksten: BriefingTeksten = standaardTekstenVoor('')
): BriefingBlock[] {
  if (recipient.role === 'acteur') {
    return alsLijst(
      sectieBlok(teksten, 'rol.als-acteur', {
        trainers: nameList(recipient.otherTrainers, format),
      })
    );
  }

  const blocks: BriefingBlock[] = [];
  if (recipient.otherTrainers.length > 0) {
    blocks.push(
      ...alsLijst(
        sectieBlok(teksten, ROLTEKST[recipient.role], {
          trainers: nameList(recipient.otherTrainers, format),
        })
      )
    );
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
      blocks.push(
        ...alsLijst(
          sectieBlok(teksten, 'rol.met-acteur', { acteurs: nameList(recipient.actors, format) })
        )
      );
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

interface Ontvanger {
  readonly recipient: Recipient;
  readonly format: (naam: string, telefoon: string) => string;
}

/**
 * De blokken die bóven `Concept inhoud` staan: wat de ontvanger zelf moet doen.
 *
 * Zonder ontvanger komen de rolblokken als zichtbare `«…»`-regel in plaats van als gok.
 */
function rolblokken(
  checklist: BriefingChecklist,
  session: SessionFacts,
  recipient: Ontvanger | undefined,
  teksten: BriefingTeksten
): BriefingBlock[] {
  return recipient === undefined
    ? roleBlocks(checklist, session)
    : recipientBlocks(recipient.recipient, checklist, recipient.format, teksten);
}

/**
 * De overige blokken, in de volgorde van het bronbestand.
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
 * voorbereidende opdracht is zelfs een van de acceptatiecriteria.
 *
 * **Openstaande vraag aan Dirkje.** `06-briefing.md` schrijft bij de voorbereidende opdracht
 * *"En dan komt de cyclus-tekst er ook bij (geneste regel)"*. Dat kan twee dingen betekenen:
 * alleen de geneste alinea (zo staat het hier), of het hele cyclusblok, ook als de cyclus
 * zelf niet is aangevinkt. De acceptatiecriteria beschrijven alleen het eerste, dus dat is
 * gebouwd; het tweede zou een blok toevoegen dat de adviseur niet heeft aangevinkt.
 */
function overigeBlokken(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  recipient: Ontvanger | undefined,
  cyclus: CyclusFeiten | null,
  teksten: BriefingTeksten
): BriefingBlock[] {
  if (checklist.ownGroup && checklist.sameGroup) {
    throw new Error(
      'Briefing: "ieder een eigen groep" en "lead- en co-trainer(s) op dezelfde groep" kunnen ' +
        'niet allebei aanstaan; dit zijn de twee antwoorden op dezelfde vraag.'
    );
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
  return [
    checklist.ownGroup ? sectieBlok(teksten, 'groep.eigen') : null,
    checklist.sameGroup ? sectieBlok(teksten, 'groep.samen') : null,
    recurringClientBlock(historie, teksten),
    checklist.trainingCycle ? trainingCycleBlock(checklist, cyclus, teksten) : null,
    checklist.homework && naarMaker ? sectieBlok(teksten, 'opdracht.huiswerk') : null,
    checklist.preparatoryAssignment && naarMaker
      ? sectieBlok(teksten, 'opdracht.voorbereidend')
      : null,
  ].flatMap(alsLijst);
}

/**
 * De blokken gesplitst in de rolblokken en de rest.
 *
 * De rolblokken staan in het document bóven `Concept inhoud`; alle andere blokken staan
 * eronder. Gesplitst op herkomst en niet op titel: sinds ITG de koppen zelf schrijft kan een
 * rolblok elke titel hebben, ook een lege of dezelfde als een ander blok.
 */
export function splitBlocks(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  session: SessionFacts,
  recipient?: Ontvanger,
  cyclus: CyclusFeiten | null = null,
  teksten: BriefingTeksten = standaardTekstenVoor('')
): { readonly rolblokken: BriefingBlock[]; readonly blokken: BriefingBlock[] } {
  const blokken = overigeBlokken(checklist, historie, recipient, cyclus, teksten);
  return { rolblokken: rolblokken(checklist, session, recipient, teksten), blokken };
}

/** Alle blokken in één lijst: eerst de rolblokken, dan de rest. */
export function selectBlocks(
  checklist: BriefingChecklist,
  historie: readonly HistoryRow[] | undefined,
  session: SessionFacts,
  recipient?: Ontvanger,
  /** De cijfers van de cyclus voor het cyclusblok; `null` als die (nog) niet bekend zijn. */
  cyclus: CyclusFeiten | null = null,
  teksten: BriefingTeksten = standaardTekstenVoor('')
): BriefingBlock[] {
  const { rolblokken: rol, blokken } = splitBlocks(
    checklist,
    historie,
    session,
    recipient,
    cyclus,
    teksten
  );
  return [...rol, ...blokken];
}
