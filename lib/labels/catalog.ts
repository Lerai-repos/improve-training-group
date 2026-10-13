import type { LabelCode, LabelConfig } from './types';

/**
 * De negen labels waarmee het bord begon. Dit is GEEN ledenlijst meer.
 *
 * Tot 13-Oct-2026 was dit de lijst van wat er mocht bestaan, en weigerde de code elke andere
 * rij op het Labels-bord. Nu is elke rij een label: ITG zet een rij neer en het label werkt
 * overal (Peter wil zo de dertien testsites onder één label `ITG` laten binnenkomen). Wat de
 * negen nog bijzonder maakt: elk heeft een eigen briefingsjabloon in `lib/briefing/templates/`.
 * Een nieuw label krijgt het algemene sjabloon met het logo van zijn rij.
 *
 * De volgorde is die van het agendabord (`status23`), niet alfabetisch, zodat de rijen op het
 * bord in dezelfde volgorde staan als in de dropdown die ITG dagelijks ziet.
 */
export const LABEL_CODES: readonly LabelCode[] = [
  'IT',
  'JE',
  'TT',
  'FV',
  'SST',
  'WJ',
  'CC',
  'CP',
  'FT',
];

const CODES: ReadonlySet<string> = new Set(LABEL_CODES);

/**
 * Of een waarde een van de negen oorspronkelijke labels is, letterlijk.
 *
 * Alleen nog om onderscheid te maken in een melding: een van de negen zonder rij is een rij
 * die verdwenen is, een ander label zonder rij is er nooit geweest.
 */
export function isLabelCode(value: string): boolean {
  return CODES.has(value);
}

/**
 * De sleutel waarop een label wordt opgezocht: een bekende schrijfwijze wordt het label waar hij
 * bij hoort (`workjoy` → `WJ`), al het andere zonder spaties eromheen en in hoofdletters.
 *
 * ÉÉN sleutel voor beide kanten. De agenda is met de hand gevuld, en `itg ` is dezelfde keuze als
 * `ITG`. En sinds elke rij op het Labels-bord een label is, kan ook die rij `WorkJoy` heten: zonder
 * de schrijfwijze in de sleutel zou een training met `WJ` die rij niet meer vinden, en zouden de
 * rijen `WJ` en `WorkJoy` niet als dubbel gezien worden. Elke opzoeking en elke dubbelcontrole
 * gaat daarom hierlangs.
 */
export function labelSleutel(value: string): string {
  const trimmed = value.trim();
  return LABEL_ALIASES[trimmed.toLowerCase()] ?? trimmed.toUpperCase();
}

/**
 * Schrijfwijzen die op het AGENDABORD naast de afkorting bestaan.
 *
 * De statuskolom `status23` definieert er zestien, waarvan negen onze codes zijn. Drie zijn
 * een tweede schrijfwijze van een label dat er al staat, en die horen naar hetzelfde merk te
 * wijzen — anders krijgt een training met "WorkJoy" geen huisstijl terwijl het merk wél
 * geconfigureerd is. `02-datamodel-monday.md` vraagt hier expliciet om.
 *
 * **Gemeten 1-Sep-2026: geen van de drie wordt vandaag gebruikt** — nul items over Agenda 2026
 * (847) en Agenda 2025 (943). Dit is dus geen reparatie van een bestaand probleem maar een
 * grendel op een keuze die iedere planner morgen kan maken, want de opties staan gewoon in de
 * dropdown.
 *
 * De vier die overblijven — `YNS`, `TMT`, `ST - StressTrainer`, `Email`, samen 19 trainingen —
 * staan hier NIET in. Dat zijn geen schrijfwijzen maar eigen labels: er raden zou een rapport
 * in de huisstijl van een ander bedrijf opleveren. Ze werken zodra ITG er een rij voor op het
 * Labels-bord zet, en tot dan meldt de dagelijkse controle ze.
 */
export const LABEL_ALIASES: Readonly<Record<string, LabelCode>> = {
  workjoy: 'WJ',
  feedbacktrainer: 'FT',
  'company cursus': 'CC',
};

/**
 * De opzoeksleutel achter een waarde uit `status23` of de Opportunity, of `null` als de cel
 * leeg is.
 *
 * Een bekende schrijfwijze wijst naar het label waar hij bij hoort (`workjoy` → `WJ`); elke
 * andere waarde is zijn eigen label, en of dat label een rij op het Labels-bord heeft beslist
 * het bord. Zo werkt een label dat ITG toevoegt zonder dat de code het kent.
 */
export function resolveLabelCode(raw: string): LabelCode | null {
  const sleutel = labelSleutel(raw);
  return sleutel === '' ? null : sleutel;
}

/**
 * De beginwaarden waarmee het bord wordt aangemaakt.
 *
 * **Herkomst per kolom, want ze komen niet uit één bron:**
 *
 * | Kolom | Waar vandaan |
 * |---|---|
 * | naam, kleur, term, rapportterm, evaluatieformulier | `snapshots/airtable/label_configuratie.json`, letterlijk |
 * | website | afgeleid van het domein van de evaluatieformulier-URL, alle acht geverifieerd op 200 |
 *
 * De lege velden zijn gemeten, niet vergeten — zie `LABEL_GAPS`.
 *
 * Dit is een STARTWAARDE. Zodra het bord staat is het bord de bron; dit blok wordt daarna
 * alleen nog gebruikt om een ontbrekende rij aan te maken, nooit om een bestaande te
 * overschrijven.
 */
export const LABEL_SEED: readonly LabelConfig[] = [
  {
    code: 'IT',
    volledigeNaam: 'Incompany Trainer',
    kleur: '#0A2B58',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: 'https://www.incompanytrainer.nl/evaluatieformulier',
    website: 'https://www.incompanytrainer.nl',
  },
  {
    code: 'JE',
    volledigeNaam: 'Job Education',
    kleur: '#1B4D33',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.jobeducation.nl/evaluatieformulier',
    website: 'https://www.jobeducation.nl',
  },
  {
    code: 'TT',
    volledigeNaam: 'Teambuilding Trainer',
    kleur: '#0A2B58',
    term: 'Teambuilding',
    rapportterm: 'de teambuilding',
    evaluatieformulier: 'https://www.teambuildingtrainer.nl/evaluatieformulier',
    website: 'https://www.teambuildingtrainer.nl',
  },
  {
    code: 'FV',
    volledigeNaam: 'Firma Vitaliteit',
    kleur: '#A3DAC2',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.firmavitaliteit.nl/evaluatieformulier',
    website: 'https://www.firmavitaliteit.nl',
  },
  {
    code: 'SST',
    volledigeNaam: 'Soft Skill Trainer',
    kleur: '#0A2B58',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: 'https://www.softskilltrainer.nl/evaluatieformulier',
    website: 'https://www.softskilltrainer.nl',
  },
  {
    code: 'WJ',
    volledigeNaam: 'WorkJoy',
    kleur: '#F78F44',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.workjoy.nl/evaluatieformulier',
    website: 'https://www.workjoy.nl',
  },
  {
    code: 'CC',
    volledigeNaam: 'Company Cursus',
    kleur: '#430521',
    term: 'Cursus',
    rapportterm: 'de cursus',
    evaluatieformulier: 'https://www.companycursus.nl/evaluatieformulier/',
    website: 'https://www.companycursus.nl',
  },
  {
    code: 'CP',
    volledigeNaam: 'Communicatie Plus',
    kleur: '#290F4B',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: 'https://www.communicatieplus.nl/evaluatieformulier/',
    website: 'https://www.communicatieplus.nl',
  },
  {
    code: 'FT',
    volledigeNaam: 'Feedback Trainer',
    kleur: '#265e5d',
    term: 'Training',
    rapportterm: 'de training',
    // Allebei leeg en dat is geen omissie van ons. `feedbacktrainer.nl` gaf 403 op
    // 1-Sep-2026, en zowel `04-evaluatierapportage.md` als `06-briefing.md` vergeten FT in
    // hun opsomming. Eén vraag aan Dirkje, twee velden.
    evaluatieformulier: '',
    website: '',
  },
];

/**
 * Wat er op 1-Sep-2026 leeg blijft, met de reden — zodat een lege cel later niet als
 * "iemand heeft het weggehaald" wordt gelezen.
 */
export const LABEL_GAPS: Readonly<Record<string, string>> = {
  'FT.evaluatieformulier': 'ITG heeft er nooit een aangeleverd',
  'FT.website': 'feedbacktrainer.nl gaf 403; het echte adres is onbekend',
};
