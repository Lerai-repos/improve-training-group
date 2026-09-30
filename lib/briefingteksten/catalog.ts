import type { Plaatshouder, SectieDefinitie, TekstGroep, TekstSleutel } from './types';

/**
 * Elke tekst in de briefing die ITG beheert, met de tekst die er op 30-Sep-2026 stond.
 *
 * Die beginwaarden komen uit `blocks.ts` en uit de negen sjablonen, en staan hier één keer:
 * `pnpm briefingteksten:create` zet ze op het bord, en daarna is het bord de bron. Een
 * sectie die van het bord verdwijnt valt dus NIET terug op deze tekst — leeg is leeg.
 *
 * Twee bewuste verschillen met de oude tekst, met Tim afgesproken: een regelafbreking bínnen
 * een alinea bestaat niet in Monday, dus het lead/co-intro zijn nu twee regels en de uitleg
 * onder "Afstemmen met de co-trainer(s)" een subregel. En de verwijzing naar het huiswerk in
 * het cyclusblok is een eigen alinea geworden.
 *
 * De volgorde hier is de volgorde op het bord, en die volgt het document.
 */

export const TEKST_GROEPEN: readonly TekstGroep[] = [
  'Algemeen',
  'Rollen',
  'Concept inhoud',
  'Groepsindeling',
  'Vaste klant',
  'Cyclus',
  'Opdrachten',
  'Inventarisatie',
];

const regels = (...r: readonly string[]): string => r.join('\n');

const LEAD_TAKEN = [
  '- Klantcontact vooraf via Teams/telefonisch',
  '- Ontwikkelen van training',
  '- Afstemmen met de co-trainer(s)',
];

const ACTEUR_LEAD_TAKEN = [
  'Belangrijk: de trainingsacteur is geen co-trainer of inhoudsdeskundige, tenzij dit ' +
    'specifiek is afgesproken. De trainer blijft eindverantwoordelijk.',
  '- De (lead) trainer is verantwoordelijk voor',
  '-- Klantcontact vooraf via Teams/telefonisch',
  '-- Ontwikkelen van inhoud van de training',
  '-- Afstemmen met de trainingsacteur en evt. co-trainer(s) over de definitieve opzet en ' +
    'uitvoering van de training',
  '-- De aansturing van de inzet van de acteur, inclusief duidelijke instructies over het ' +
    'gewenste gedrag of de context waarin de acteur acteert',
];

const ACTEUR_TAKEN = [
  '-- Het tot leven brengen van de praktijk',
  '-- Het afstemmen van zijn/haar spel op het niveau van de deelnemer & het leerdoel. Dit ' +
    'gebeurt in overleg met de trainer, al dan niet op aanvraag van de deelnemer',
];

export const SECTIES: readonly SectieDefinitie[] = [
  {
    sleutel: 'algemeen.inleiding',
    groep: 'Algemeen',
    naam: 'Inleiding',
    heeftKop: true,
    kop: '',
    tekst:
      'Binnenkort organiseer je namens {merk} een {term} bij een van onze klanten. Alle ' +
      'informatie in deze briefing is aangedragen door de klant zodat je de {term} perfect kan ' +
      'afstemmen op hun situatie en wensen. We benadrukken graag nog even de punten die voor ' +
      'ons belangrijk zijn:',
    plaatshouders: [],
    wanneer: 'Altijd, bovenaan onder "Algemeen."',
  },
  {
    sleutel: 'algemeen.vlag',
    groep: 'Algemeen',
    naam: 'Onder onze vlag',
    heeftKop: true,
    kop: 'Onder de vlag van {merk}',
    tekst:
      'Het is voor ons belangrijk dat je bij de klant werkt onder onze vlag. Dat houdt in dat ' +
      'je je naar de klant toe presenteert als trainer van {merk}. Acquisitie voor het eigen ' +
      'bedrijf cq. dienstverlening is niet toegestaan.',
    plaatshouders: [],
    wanneer: 'Altijd',
  },
  {
    sleutel: 'algemeen.vervolg',
    groep: 'Algemeen',
    naam: 'Vervolg of aanvullende diensten',
    heeftKop: true,
    kop: 'Behoefte aan vervolg of aanvullende diensten',
    tekst:
      'Indien de klant aanvullende of opvolgende behoeftes heeft kan je dit met ons ' +
      'communiceren, of je kan de klant doorverwijzen naar ons. Wij treden dan in contact met ' +
      'de klant om de mogelijkheden te bespreken.',
    plaatshouders: [],
    wanneer: 'Altijd',
  },
  {
    sleutel: 'algemeen.materialen',
    groep: 'Algemeen',
    naam: 'Materialen',
    heeftKop: true,
    kop: 'Materialen',
    tekst:
      'Het is belangrijk dat alles er professioneel en uniform uit ziet. Alle materialen, ' +
      'presentaties, et cetera, worden daarom in de huisstijl van {merk} gebruikt tijdens de ' +
      '{term}. Heb je materialen die nog niet in onze huisstijl omgezet zijn? Stuur het dan ' +
      'even door zodat we dit voor de {term} kunnen doen.',
    plaatshouders: [],
    wanneer: 'Altijd',
  },
  {
    sleutel: 'algemeen.inhoud',
    groep: 'Algemeen',
    naam: 'Inhoud',
    heeftKop: true,
    kop: 'Inhoud {term}',
    tekst:
      'De klant heeft de {term} geboekt op basis van de content zoals die op onze website te ' +
      'vinden is. Het is belangrijk dat die inhoud tijdens de {term} aangeraakt wordt.',
    plaatshouders: [],
    wanneer: 'Altijd',
  },
  {
    sleutel: 'algemeen.afsluiting',
    groep: 'Algemeen',
    naam: 'Afsluiting',
    heeftKop: true,
    kop: '',
    tekst: 'Vragen? We horen het graag!',
    plaatshouders: [],
    wanneer: 'Altijd, als laatste van de algemene tekst',
  },
  {
    sleutel: 'algemeen.monday-challenges',
    groep: 'Algemeen',
    naam: 'Monday Challenges',
    heeftKop: false,
    kop: '',
    tekst: '!! Vergeet de Monday Challenges niet aan te bieden in je sessie !!',
    plaatshouders: [],
    wanneer: 'Altijd, als cyaan regel boven de gegevenstabel',
  },
  {
    sleutel: 'rol.leadtrainer',
    groep: 'Rollen',
    naam: 'Leadtrainer',
    heeftKop: true,
    kop: 'Leadtrainer',
    tekst: regels(
      'Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: {trainers}.',
      'Jij bent de leadtrainer en dus verantwoordelijk voor:',
      ...LEAD_TAKEN,
      '-- Alle trainers (jij en de co-trainers) krijgen deze briefing, maar jij bent ' +
        'verantwoordelijk voor het duidelijk briefen van de trainers over de definitieve opzet ' +
        'en uitvoering van de training.',
      '- De terugkoppeling en nabespreking met de klant en mij'
    ),
    plaatshouders: ['trainers'],
    wanneer: 'In het document van de leadtrainer, als er meer trainers zijn',
  },
  {
    sleutel: 'rol.co-trainer',
    groep: 'Rollen',
    naam: 'Co-trainer',
    heeftKop: true,
    kop: 'Co-trainer',
    tekst: regels(
      'Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: {trainers}.',
      'Jij bent ingedeeld als co-trainer. De leadtrainer is verantwoordelijk voor:',
      ...LEAD_TAKEN,
      '-- Alle trainers (jij en de lead trainer) krijgen deze briefing, maar de lead trainer is ' +
        'verantwoordelijk voor het duidelijk briefen van de co-trainer(s) over de definitieve ' +
        'opzet en uitvoering van de training.',
      '- De terugkoppeling en nabespreking met de klant en mij',
      'Als je wilt, kun je alvast contact opnemen met de leadtrainer.'
    ),
    plaatshouders: ['trainers'],
    wanneer: 'In het document van een co-trainer',
  },
  {
    sleutel: 'rol.met-acteur',
    groep: 'Rollen',
    naam: 'Werken met een trainingsacteur',
    heeftKop: true,
    kop: 'Werken met een trainingsacteur',
    tekst: regels(
      'Voor deze opdracht werk je met een trainingsacteur: {acteurs}. Om een zo hoog mogelijk ' +
        'leerrendement te realiseren is er een duidelijke taakverdeling binnen de samenwerking ' +
        'met de (lead) trainer en trainingsacteur.',
      ...ACTEUR_LEAD_TAKEN,
      '- De trainingsacteur is verantwoordelijk het',
      ...ACTEUR_TAKEN,
      '-- Geven van feedback vanuit de rol (o.b.v. gedrag) én als observator (verbaal)'
    ),
    plaatshouders: ['acteurs'],
    wanneer: 'In het document van een trainer, als er een trainingsacteur meewerkt',
  },
  {
    sleutel: 'rol.als-acteur',
    groep: 'Rollen',
    naam: 'Werken als trainingsacteur',
    heeftKop: true,
    kop: 'Werken als trainingsacteur',
    tekst: regels(
      'Voor deze opdracht word je ingezet als trainingsacteur, naast de (lead) trainer: ' +
        '{trainers}. Om een zo hoog mogelijk leerrendement te realiseren is er een duidelijke ' +
        'taakverdeling binnen de samenwerking met de (lead) trainer en trainingsacteur.',
      ...ACTEUR_LEAD_TAKEN,
      '- De trainingsacteur is verantwoordelijk voor',
      ...ACTEUR_TAKEN,
      '-- Het geven van feedback vanuit de rol (o.b.v. gedrag) én als observator (verbaal)'
    ),
    plaatshouders: ['trainers'],
    wanneer: 'In het document van de trainingsacteur',
  },
  {
    sleutel: 'concept.inleiding',
    groep: 'Concept inhoud',
    naam: 'Concept inhoud',
    heeftKop: true,
    kop: 'Concept inhoud',
    tekst: 'Het volgende concept programma is gecommuniceerd met de klant.',
    plaatshouders: [],
    wanneer:
      "Altijd. De opsomming eronder komt van het Thema's-bord (of uit de tab), niet van hier",
  },
  {
    sleutel: 'groep.eigen',
    groep: 'Groepsindeling',
    naam: 'Ieder een eigen groep',
    heeftKop: true,
    kop: 'Ieder een eigen groep',
    tekst:
      'Elke trainer traint een eigen groep. Het is belangrijk dat dit zo veel mogelijk op ' +
      'dezelfde manier gebeurt. Gebruik bijvoorbeeld dezelfde opzet en (soort) werkvormen.',
    plaatshouders: [],
    wanneer: 'Als in de tab "Ieder een eigen groep" is gekozen',
  },
  {
    sleutel: 'groep.samen',
    groep: 'Groepsindeling',
    naam: 'Dezelfde groep',
    heeftKop: true,
    kop: 'Lead- en co-trainer(s) op dezelfde groep',
    tekst:
      'Jullie trainen samen de gehele groep, deze wordt dus niet opgesplitst over meerdere ' +
      'locaties. Zorg daarom voor een goede afstemming. Houd er rekening mee dat de klant ' +
      'extra betaalt voor de co-trainer(s). Het is daarom belangrijk dat alle trainers een ' +
      'actieve en duidelijke rol hebben tijdens de sessie(s).',
    plaatshouders: [],
    wanneer: 'Als in de tab "Lead- en co-trainer(s) op dezelfde groep" is gekozen',
  },
  {
    sleutel: 'vaste-klant',
    groep: 'Vaste klant',
    naam: 'Vaste klant',
    heeftKop: true,
    kop: 'Vaste klant',
    tekst:
      'Voor deze klant hebben we meerdere sessies georganiseerd staan (verleden en/of ' +
      'toekomst). Zie hieronder een overzicht van de sessies die zijn geweest en/of nog ' +
      'gepland staan, inclusief alle informatie die wij ervoor hebben.',
    plaatshouders: [],
    wanneer:
      'Als er bij deze klant andere sessies zijn. De tabel met sessies komt eronder en blijft ' +
      'staan, ook als deze tekst leeg is',
  },
  {
    sleutel: 'cyclus.inleiding',
    groep: 'Cyclus',
    naam: 'Cyclus',
    heeftKop: true,
    kop: 'Trainings/workshop/teambuilding cyclus',
    tekst:
      'Bij een trainingscyclus van {duur} volgt de groep {aantal} sessies over één thema. ' +
      'Tussen de sessies zit een oefen- en integratieperiode van zo’n 2 à 3 weken, of langer ' +
      'indien gewenst, waarin deelnemers bezig zijn met een huiswerkopdracht.',
    plaatshouders: ['duur', 'aantal'],
    wanneer: 'Bij een trainingscyclus',
  },
  {
    sleutel: 'cyclus.huiswerk',
    groep: 'Cyclus',
    naam: 'Cyclus – huiswerk',
    heeftKop: false,
    kop: '',
    tekst: 'Voor instructies over de huiswerkopdracht, zie kopje ‘Huiswerkopdracht’.',
    plaatshouders: [],
    wanneer: 'Bij een trainingscyclus mét huiswerkopdracht, direct onder de cyclustekst',
  },
  {
    sleutel: 'cyclus.voorbereiding',
    groep: 'Cyclus',
    naam: 'Cyclus – voorbereiding',
    heeftKop: false,
    kop: '',
    tekst: 'Vóór de eerste sessie ontvangen deelnemers een voorbereidende reflectieopdracht.',
    plaatshouders: [],
    wanneer: 'Bij een trainingscyclus mét voorbereidende opdracht',
  },
  {
    sleutel: 'cyclus.afsluiting',
    groep: 'Cyclus',
    naam: 'Cyclus – afsluiting',
    heeftKop: false,
    kop: '',
    tekst: regels(
      'Tijdens de laatste sessie definiëren deelnemers hun eigen Next Step. Dit is een ' +
        'concrete vervolgstap waar ze na de training zelfstandig mee verder kunnen. Deze Next ' +
        'Step kan eventueel worden opgenomen in de ontwikkelgesprekken tussen manager en ' +
        'medewerker.',
      'Door deze cyclus komen deelnemers meerdere keren in contact met de lesstof. Dit heeft ' +
        'een grote positieve invloed op het leerrendement. De cyclus ziet er dus als volgt uit:'
    ),
    plaatshouders: [],
    wanneer: 'Bij een trainingscyclus. Het cyclusschema komt eronder',
  },
  {
    sleutel: 'opdracht.huiswerk',
    groep: 'Opdrachten',
    naam: 'Huiswerkopdracht',
    heeftKop: true,
    kop: 'Huiswerkopdracht',
    tekst: regels(
      'In overeenstemming met de klant verzorgen wij een huiswerkopdracht voor de deelnemers. ' +
        'Jij geeft deze vorm, afgestemd op de opdracht en groep. Denk alsjeblieft aan de ' +
        'volgende zaken:',
      '- De opdracht dient deelnemers te helpen om de inhoud van de training direct in de ' +
        'praktijk toe te passen, inzichten op te doen en eventuele knelpunten of vragen ' +
        'zichtbaar te maken.',
      '- Zorg er zo veel mogelijk voor dat de opdracht als onderdeel van het werk kan worden ' +
        'uitgevoerd, in plaats van dat het de deelnemers extra tijd kost.',
      '- Is de huiswerkopdracht niet onderdeel van een trainingscyclus (dus meerdere ' +
        'opvolgende sessies vanuit ons)? Spreek dan met de groep af of en hoe ze de uitvoer ' +
        'van de opdracht borgen.'
    ),
    plaatshouders: [],
    wanneer: 'Bij een huiswerkopdracht. Niet in het document van de trainingsacteur',
  },
  {
    sleutel: 'opdracht.voorbereidend',
    groep: 'Opdrachten',
    naam: 'Voorbereidende opdracht',
    heeftKop: true,
    kop: 'Voorbereidende opdracht',
    tekst: regels(
      'Voor deze opdracht werken we met een voorbereidende opdracht, zodat jij vooraf meer ' +
        'inzicht krijgt in de situatie en leerdoelen van de deelnemers.',
      'Ook kunnen de antwoorden inzicht geven of je aan het begin van de sessie de ' +
        'verwachtingen van de deelnemers moet managen, omdat er bijvoorbeeld te uiteenlopende ' +
        'verwachtingen zijn van de sessie. Mocht dit laatste gebeuren, laat mij dit dan ' +
        'alsjeblieft weten, zodat ik het met de contactpersoon kan bespreken.',
      'In de bijlage van de mail vind je een template met voorbeeldvragen. Zou je deze willen ' +
        'aanpassen zodat deze aansluit op jouw sessie en vervolgens met mij delen? Dan zorg ik ' +
        'ervoor dat deze bij de klant terechtkomt.'
    ),
    plaatshouders: [],
    wanneer: 'Bij een voorbereidende opdracht. Niet in het document van de trainingsacteur',
  },
  {
    sleutel: 'inventarisatie.inleiding',
    groep: 'Inventarisatie',
    naam: 'Inventarisatie klant',
    heeftKop: true,
    kop: 'Inventarisatie klant',
    tekst:
      'Onderstaande informatie komt uit het inventarisatieformulier. Gebruik de context en ' +
      'casuïstiek als input voor de workshop.',
    plaatshouders: [],
    wanneer: 'Altijd, als laatste sectie. De antwoorden uit het formulier komen eronder',
  },
  {
    sleutel: 'inventarisatie.leeg',
    groep: 'Inventarisatie',
    naam: 'Inventarisatie – niet ingevuld',
    heeftKop: false,
    kop: '',
    tekst: 'Het inventarisatieformulier is (nog) niet ingevuld door de klant.',
    plaatshouders: [],
    wanneer: 'Als de klant het inventarisatieformulier nog niet heeft ingevuld',
  },
];

const PER_SLEUTEL: ReadonlyMap<string, SectieDefinitie> = new Map(
  SECTIES.map((s) => [s.sleutel, s])
);

/** De definitie bij een sleutel van het bord, of `null` als die sleutel niet van ons is. */
export function sectieVoor(sleutel: string): SectieDefinitie | null {
  return PER_SLEUTEL.get(sleutel.trim()) ?? null;
}

/** De definitie bij een sleutel die zeker bestaat. */
export function sectie(sleutel: TekstSleutel): SectieDefinitie {
  const gevonden = PER_SLEUTEL.get(sleutel);
  if (gevonden === undefined) {
    throw new Error(`Briefingteksten: geen sectie ${sleutel} in de catalogus`);
  }
  return gevonden;
}

const UITLEG_PLAATSHOUDER: Readonly<Record<Plaatshouder, string>> = {
  merk: 'de naam van het label, bijv. Incompany Trainer',
  term: 'training, workshop, cursus of teambuilding, per label',
  trainers: 'de naam en het telefoonnummer van de andere trainer(s)',
  acteurs: 'de naam en het telefoonnummer van de trainingsacteur(s)',
  duur: 'de totale duur van de cyclus, bijv. 4 + 3 uur',
  aantal: 'het aantal sessies in woorden, bijv. twee',
};

/** De tekst voor de kolom Uitleg: wanneer de sectie verschijnt en wat er ingevuld kan worden. */
export function uitlegVoor(definitie: SectieDefinitie): string {
  const plaatshouders: readonly Plaatshouder[] = ['merk', 'term', ...definitie.plaatshouders];
  return [
    `Staat in de briefing: ${definitie.wanneer}.`,
    definitie.heeftKop ? '' : 'Deze sectie heeft geen kop; laat Kop leeg.',
    'Plaatshouders:',
    ...plaatshouders.map((p) => `{${p}} = ${UITLEG_PLAATSHOUDER[p]}`),
  ]
    .filter((r) => r !== '')
    .join('\n');
}
