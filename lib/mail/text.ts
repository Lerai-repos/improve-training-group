import { INVULLEN, klantEnTitel } from './facts';

import type { MailFacts } from './facts';

/**
 * De vier mailteksten, letterlijk uit `ITG IE automatiseren - V2 standaard mails update
 * begin juli 2026.docx`.
 *
 * ## Twee soorten gaten, en waarom ze verschillend behandeld worden
 *
 * In het brondocument is geel wat ITG uit onze data verwacht en rood wat ze zelf aanpassen.
 * Het gele vullen wij in. Het rode blijft staan als `[HOOFDLETTERS TUSSEN HAKEN]`, want dat
 * is de enige vorm die het plakken naar Outlook overleeft en die iemand niet per ongeluk
 * meestuurt. Een net geformuleerde maar lege zin zou wél meegestuurd worden.
 *
 * ## Elke mail heeft een kop die niet mee mag
 *
 * De ontvanger is niet de klant maar een gedeelde postbus van ITG. Boven de tekst staat dus
 * wat ITG moet doen, en daaronder pas de tekst zelf, gescheiden door een streepjeslijn. Dat
 * is ook waar het e-mailadres van de trainer en de naam van de accountmanager staan: twee
 * van de vier reparaties uit `04-evaluatierapportage.md` gaan erover dat die niet goed
 * ingevuld werden.
 */

/** De scheiding tussen wat ITG moet doen en wat ze doorsturen. */
const STREEP = '========================================';

/** De directe formulierlinks, voor het geval de klant hem alsnog wil nasturen. */
const FORMULIER_NL = 'https://forms.gle/P9CBnDgVhbz8iRZp9';
const FORMULIER_EN = 'https://forms.gle/nCgrK9tdiw792MJr9';

const ONTBREEKT_URL = INVULLEN('EVALUATIEFORMULIER VAN DIT LABEL ONTBREEKT OP HET LABELS-BORD');

/**
 * Een kopje. In de HTML dikgedrukt, in de platte tekst een gewone regel.
 *
 * Een eigen vorm en geen opmaak in de tekst zelf: de platte tekst blijft wat hij was (voor de
 * droogloop, het logboek en de tests), en de HTML is een opmaak van precies die regels.
 */
interface Kopje {
  readonly kopje: string;
}

type Regel = string | Kopje | null;

const kopje = (tekst: string): Kopje => ({ kopje: tekst });

const tekstVan = (regel: string | Kopje): string =>
  typeof regel === 'string' ? regel : regel.kopje;

const aanwezig = (regels: readonly Regel[]): readonly (string | Kopje)[] =>
  regels.filter((r): r is string | Kopje => r !== null);

/** Regels aan elkaar, met lege regels waar ze staan, zonder spaties aan de randen. */
const samen = (regels: readonly Regel[]): string => aanwezig(regels).map(tekstVan).join('\n');

/**
 * Calibri 11 op elke alinea en niet alleen op de buitenste: wie de tekst in zijn eigen mail
 * plakt neemt alinea's mee, niet de omhullende `div`, en die zou dan in zijn eigen lettertype
 * terugvallen.
 */
const LETTER = 'font-family:Calibri,Arial,sans-serif;font-size:11pt';
const ALINEA = `<p style="margin:0;${LETTER}">`;
export const HTML_BEGIN = `<div style="${LETTER}">`;

const ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/**
 * Een adres klikbaar, zonder de punt of komma waar de zin mee doorloopt. Pas ná het ontsnappen,
 * zodat een `&` in een adres als `&amp;` in de `href` staat, zoals HTML het wil.
 */
const metLinks = (veilig: string): string =>
  veilig.replace(/https?:\/\/[^\s<]*[^\s<.,;:)]/g, (url) => `<a href="${url}">${url}</a>`);

const alsAlinea = (regel: string | Kopje): string => {
  const veilig = metLinks(tekstVan(regel).replace(/[&<>"]/g, (teken) => ESCAPE[teken] ?? teken));
  const inhoud = veilig === '' ? '&nbsp;' : typeof regel === 'string' ? veilig : `<b>${veilig}</b>`;
  return `${ALINEA}${inhoud}</p>`;
};

/**
 * Dezelfde regels als HTML: één alinea per regel, kopjes dikgedrukt, alles in Calibri 11.
 *
 * Dat ITG dit vraagt (12-Oct-2026) weegt zwaarder dan de oorspronkelijke keuze voor platte
 * tekst: de mails vóór de overstap waren ook HTML, en de `[HOOFDLETTERS]` blijven gewoon tekst.
 */
const alsHtml = (regels: readonly Regel[]): string =>
  `${HTML_BEGIN}${aanwezig(regels).map(alsAlinea).join('')}</div>`;

const mail = (subject: string, regels: readonly Regel[]): MailText => ({
  subject,
  body: samen(regels),
  html: alsHtml(regels),
});

/** Een regel bovenaan, met een lege regel eronder, in beide versies; zie `composeMails`. */
export function metKopregel(tekst: MailText, regel: string): MailText {
  return {
    subject: tekst.subject,
    body: `${regel}\n\n${tekst.body}`,
    html: tekst.html.replace(HTML_BEGIN, `${HTML_BEGIN}${alsAlinea(regel)}${alsAlinea('')}`),
  };
}

const aanhef = (naam: string): string => (naam === '' ? 'Hoi,' : `Hoi ${naam},`);

const formulierRegel = (facts: MailFacts): string =>
  facts.evaluatieformulier === '' ? ONTBREEKT_URL : facts.evaluatieformulier;

/**
 * "de sessie over Feedback geven", of gewoon "de sessie" als er geen thema gekoppeld is.
 *
 * Zonder deze uitweg staat er "de sessie over ." in een brief aan een klant. Het thema is
 * op het agendabord een relatie die leeg mág zijn.
 */
const sessieOver = (facts: MailFacts): string =>
  facts.thema === '' ? 'de sessie' : `de sessie over ${facts.thema}`;

/**
 * De drie cijferzinnen, die alle drie kunnen wegvallen.
 *
 * Een sessie kan respondenten hebben die geen van allen een eindcijfer gaven, en een
 * vervolgvraag die niemand beantwoordde. Dan hoort die zin er niet te staan in plaats van
 * "een gemiddelde van een null" te melden.
 */
function evaluatieUitslag(facts: MailFacts): string {
  const zinnen = [
    'Tijdens de sessie is er een QR-code gedeeld zodat deelnemers konden evalueren.',
    `De evaluatie is door ${facts.aantalRespondenten} mensen ingevuld.`,
  ];
  if (facts.gemiddelde !== null) {
    zinnen.push(
      `De sessie is door de groep beoordeeld met een gemiddelde van een ${facts.gemiddelde}.`
    );
  }
  if (facts.vervolgPercentage !== null) {
    zinnen.push(
      `Daarnaast heeft ${facts.vervolgPercentage}% van de respondenten aangegeven een ` +
        'verdiepende sessie waardevol te vinden.'
    );
  }
  return zinnen.join(' ');
}

/**
 * Twee kant-en-klare varianten, net als bij Vervolg. Eerder stonden beide teksten tussen
 * aanhalingstekens in één opdracht en moest de accountmanager ze eruit knippen (Dirkje,
 * 12-Oct-2026: "de keer kiezen bij Vervolg werkt fijn").
 */
const SLIDES: readonly Regel[] = [
  kopje('Slides'),
  INVULLEN(
    'KIES VARIANT A (MET WETRANSFER-LINK) OF B (SLIDES ALS BIJLAGE), VERWIJDER DE ANDER. ' +
      'GEEN SLIDES? DAN DIT BLOK VERWIJDEREN'
  ),
  `Variant A: Hierbij vind je ook de slides van de sessie. Handig als naslagwerk. ${INVULLEN('WETRANSFER-LINK')}`,
  '',
  'Variant B: In de bijlage vind je ook de slides van de sessie.',
];

const vervolgBlok = (facts: MailFacts): readonly Regel[] => [
  kopje('Vervolg'),
  INVULLEN('KIES VARIANT A OF B, VERWIJDER DE ANDER'),
  `Variant A: Mocht je enthousiast zijn over ${facts.rapportterm}, dan is het wellicht handig ` +
    'om in contact te blijven voor eventuele toekomstige sessies. Ik kan bijvoorbeeld over ' +
    '2 à 3 maanden een bijpraatmoment inschieten? Laat me maar weten of je daarvoor open staat.',
  '',
  `Variant B: Mocht je enthousiast zijn over ${facts.rapportterm}, dan is het wellicht handig ` +
    'om in contact te blijven voor eventuele toekomstige sessies. Zoals aangegeven gaf ' +
    `${facts.trainerNamen === '' ? 'de trainer' : facts.trainerNamen} aan dat het waardevol ` +
    'zou kunnen zijn om met elkaar te verdiepen in thema’s als: ' +
    `${INVULLEN('VERDIEPINGSTHEMA’S')} omdat ${INVULLEN('REDEN')}. We kunnen over ` +
    '2 à 3 maanden een bijpraatmoment inschieten en evt. bovenstaande onderwerpen meenemen? ' +
    'Laat me maar weten of je daarvoor open staat.',
];

const BEDANKT: readonly Regel[] = [
  kopje('Bedankt'),
  'Voor nu wil ik je bedanken voor het fijne contact! Hopelijk kunnen we snel weer iets voor ' +
    'jullie betekenen.',
];

const evaluatieBlok = (facts: MailFacts): readonly Regel[] => [
  kopje('Evaluatie'),
  'Ik ben heel benieuwd hoe je onze dienstverlening hebt ervaren. Zou je daarom ons ' +
    'evaluatieformulier in willen vullen? Dit duurt maximaal 5 minuten en je vindt het ' +
    `formulier hier: ${formulierRegel(facts)}`,
];

export interface MailText {
  readonly subject: string;
  /** Platte tekst: voor de droogloop, het logboek en de tests. */
  readonly body: string;
  /** Wat er verstuurd wordt; dezelfde regels, opgemaakt. */
  readonly html: string;
}

/** Kop met de vaste feiten, zodat een postbus met dertig van deze mails te sorteren is. */
const kop = (facts: MailFacts, regels: readonly string[]): readonly string[] => [
  `Training: ${facts.klanttitel}`,
  `Klant: ${facts.klant === '' ? '(geen bedrijf gekoppeld op het agendabord)' : facts.klant}`,
  `Datum: ${facts.datum === '' ? '(geen datum op het agendabord)' : facts.datum}`,
  `Label: ${facts.labelNaam}`,
  `IE-code: ${facts.ieCode}`,
  ...regels,
  '',
  STREEP,
  '',
];

/** Variant 1: aftersales MET formulier, naar de accountmanagers. */
export function aftersalesMet(facts: MailFacts): MailText {
  return mail(`Aftersales ${klantEnTitel(facts)} (${facts.datum}) – evaluatie bijgevoegd`, [
    ...kop(facts, [
      'Actie: stuur onderstaande tekst met het bijgevoegde rapport door naar de klant.',
    ]),
    aanhef(facts.contactNamen),
    '',
    `Op ${facts.datum} organiseerden we bij jullie ${sessieOver(facts)}. Ik ben benieuwd hoe ` +
      'jullie erop terugkijken!',
    '',
    `${facts.trainerNamen === '' ? 'De trainer' : facts.trainerNamen} was in ieder geval erg ` +
      'enthousiast over de sessie en de groep. ' +
      INVULLEN(
        'WAT DE TRAINER OPVIEL: wat merkte hij of zij, en waar is behoefte aan ' +
          'verdieping of verbreding?'
      ),
    '',
    ...evaluatieBlok(facts),
    '',
    kopje('Individuele evaluatie deelnemers'),
    evaluatieUitslag(facts),
    '',
    'Ik heb de uitslag van de individuele evaluatie bijgevoegd. Ik kan me voorstellen dat de ' +
      'uitkomsten ook voor jou interessant zijn.',
    '',
    ...SLIDES,
    '',
    ...vervolgBlok(facts),
    '',
    ...BEDANKT,
  ]);
}

/** Variant 2: aftersales ZONDER formulier, naar de accountmanagers. */
export function aftersalesZonder(facts: MailFacts): MailText {
  return mail(`Aftersales ${klantEnTitel(facts)} (${facts.datum}) – GEEN evaluaties gevonden`, [
    ...kop(facts, [
      'Actie: vraag bij de trainer na waarom er geen antwoorden zijn, en stuur onderstaande ' +
        'tekst door naar de klant.',
      'Check of backoffice jou in CC heeft gezet in de mail naar de trainer.',
      `De status 'IE. Trainer' in Monday is al automatisch op 'Onvindbaar' gezet.`,
    ]),
    aanhef(facts.contactNamen),
    '',
    `Op ${facts.datum} organiseerden we bij jullie ${facts.rapportterm} ${facts.klanttitel}. ` +
      'Ik ben benieuwd hoe jullie erop terugkijken!',
    '',
    INVULLEN(
      'WAT DE TRAINER OPVIEL: wat merkte hij of zij, en waar is behoefte aan verdieping of ' +
        'verbreding?'
    ),
    '',
    ...evaluatieBlok(facts),
    '',
    kopje('Individuele evaluatie deelnemers'),
    'Tijdens de sessie is er een QR-code gedeeld zodat deelnemers konden evalueren. Helaas ' +
      'hebben wij geen antwoorden ontvangen van deelnemers. Ik ben benieuwd of jij al een ' +
      'terugkoppeling hebt van één of meerdere deelnemers?',
    '',
    'Natuurlijk kun je het formulier ook nog nasturen naar de deelnemers, inclusief een ' +
      'deadline waarop ze deze uiterlijk kunnen invullen. Als je dat doet, kun je mij dat ' +
      'laten weten? En ook welke datum je als deadline hebt opgegeven? Dan zorg ik dat ik ' +
      'daarna het rapport opmaak en deze met je deel.',
    '',
    `Nederlands formulier: ${FORMULIER_NL}`,
    `Engels formulier: ${FORMULIER_EN}`,
    `Let op: het is belangrijk dat de deelnemers de volgende code invoeren: ${facts.ieCode}`,
    '',
    ...SLIDES,
    '',
    ...vervolgBlok(facts),
    '',
    ...BEDANKT,
  ]);
}

/**
 * De regels die backoffice nodig heeft om door te sturen.
 *
 * Twee van de vier reparaties uit `04-evaluatierapportage.md` gaan hierover: de naam van de
 * accountmanager en het e-mailadres van de trainer werden niet goed ingevuld. Ze staan hier
 * dus expliciet, en als ze ontbreken staat er wát er ontbreekt in plaats van een lege regel.
 */
const trainerKopRegels = (facts: MailFacts): readonly string[] => [
  `Trainer: ${facts.trainerNamen === '' ? '(geen trainer gekoppeld)' : facts.trainerNamen}`,
  `E-mail trainer: ${
    facts.trainerEmails.length === 0
      ? '(geen e-mailadres op het trainersbord)'
      : facts.trainerEmails.join(', ')
  }`,
  `Accountmanager in CC: ${
    facts.accountmanager === '' ? '(geen accountmanager op het agendabord)' : facts.accountmanager
  }`,
];

/** Variant 3: trainerevaluatie MET formulier, naar backoffice. */
export function trainerMet(facts: MailFacts): MailText {
  return mail(`Trainerevaluatie ${facts.trainerNamen} – ${klantEnTitel(facts)} (${facts.datum})`, [
    ...kop(facts, [
      ...trainerKopRegels(facts),
      'Actie: stuur onderstaande tekst met het bijgevoegde rapport door naar de trainer, met ' +
        'de accountmanager in CC.',
    ]),
    aanhef(facts.trainerNamen),
    '',
    `Op ${facts.datum} heb jij via ${facts.labelNaam} ${sessieOver(facts)} gegeven. Als het ` +
      'goed is heb je de verantwoordelijke Accountmanager al laten weten hoe de sessie is ' +
      'gegaan. Mocht dat niet zo zijn, zou je dit dan alsjeblieft nog laten weten?',
    '',
    kopje('Individuele evaluatie deelnemers'),
    evaluatieUitslag(facts),
    '',
    'Ik heb de uitslag van de individuele evaluatie bijgevoegd. Ik kan me voorstellen dat de ' +
      'uitkomsten ook voor jou interessant zijn.',
  ]);
}

/** Variant 4: trainerevaluatie ZONDER formulier, naar backoffice. */
export function trainerZonder(facts: MailFacts): MailText {
  return mail(
    `Trainerevaluatie ${facts.trainerNamen} – ${klantEnTitel(facts)} (${facts.datum}) ` +
      '– GEEN evaluaties gevonden',
    [
      ...kop(facts, [
        ...trainerKopRegels(facts),
        'Actie: stuur onderstaande tekst door naar de trainer, met de accountmanager in CC.',
        `De status 'IE. Trainer' in Monday is al automatisch op 'Onvindbaar' gezet; dat hoeft ` +
          'niet meer met de hand.',
      ]),
      aanhef(facts.trainerNamen),
      '',
      `Op ${facts.datum} heb jij via ${facts.labelNaam} ${sessieOver(facts)} gegeven. Als het ` +
        'goed is heb je de verantwoordelijke Accountmanager al laten weten hoe de sessie is ' +
        'gegaan. Mocht dat niet zo zijn, zou je dit dan alsjeblieft nog laten weten?',
      '',
      'In de briefing is een QR-code gedeeld, maar helaas zijn er geen antwoorden op de ' +
        'vragenlijst gevonden.',
    ]
  );
}
