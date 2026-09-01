import type { LabelCode, LabelConfig } from './types';

/**
 * De negen labels, in code. Dit is de LEDENLIJST; het bord is de configuratie.
 *
 * Bewust niet van het bord gelezen. Elk label heeft een eigen briefingsjabloon in
 * `lib/briefing/templates/`, en dat is een bestand in de repo: een tiende rij op het bord
 * levert dus geen tiende label op maar een briefing die niet gegenereerd kan worden. Code
 * beslist wélke labels bestaan, het bord beslist hoe ze eruitzien.
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
 * Of een waarde een canonieke labelcode is.
 *
 * STRIKT, met opzet: dit bewaakt de rijen op het Labels-bord, waar de itemnaam de code IS.
 * Een rij die "WorkJoy" heet moet geweigerd worden, want die zou naast de rij "WJ" komen te
 * staan en dan zijn er twee rijen voor één merk. Voor de agenda, waar zulke schrijfwijzen wél
 * voorkomen, is er `resolveLabelCode`.
 */
export function isLabelCode(value: string): value is LabelCode {
  return CODES.has(value);
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
 * staan hier NIET in. Dat zijn geen schrijfwijzen maar onbekende labels: er is geen merk om
 * ze op te laten wijzen, en er raden zou een rapport in de huisstijl van een ander bedrijf
 * opleveren. Die horen gemeld te worden, zoals hetzelfde document voorschrijft.
 */
export const LABEL_ALIASES: Readonly<Record<string, LabelCode>> = {
  workjoy: 'WJ',
  feedbacktrainer: 'FT',
  'company cursus': 'CC',
};

/**
 * De labelcode achter een waarde uit `status23`, of `null` als wij het label niet kennen.
 *
 * Hoofdletterongevoelig en met spaties eraf: de agenda is met de hand gevuld, en `WJ ` of
 * `workjoy` is dezelfde keuze als `WJ`.
 */
export function resolveLabelCode(raw: string): LabelCode | null {
  const trimmed = raw.trim();
  if (isLabelCode(trimmed)) {
    return trimmed;
  }
  const upper = trimmed.toUpperCase();
  if (isLabelCode(upper)) {
    return upper;
  }
  return LABEL_ALIASES[trimmed.toLowerCase()] ?? null;
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
 * | inventarisatieformulier | Dirkje's annotatie in `docs/build/06-briefing.md`, alle zes geverifieerd bereikbaar |
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
    // Zelfde formulier als JE. Geen overschrijffout: het is één document, twee labels.
    inventarisatieformulier:
      'https://docs.google.com/forms/d/1Ca6ZX624PWNU2EjFfgR0n4K_vq-ceA3Ybba70gadWyg/viewform',
  },
  {
    code: 'JE',
    volledigeNaam: 'Job Education',
    kleur: '#1B4D33',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.jobeducation.nl/evaluatieformulier',
    website: 'https://www.jobeducation.nl',
    inventarisatieformulier:
      'https://docs.google.com/forms/d/1Ca6ZX624PWNU2EjFfgR0n4K_vq-ceA3Ybba70gadWyg/viewform',
  },
  {
    code: 'TT',
    volledigeNaam: 'Teambuilding Trainer',
    kleur: '#0A2B58',
    term: 'Teambuilding',
    rapportterm: 'de teambuilding',
    evaluatieformulier: 'https://www.teambuildingtrainer.nl/evaluatieformulier',
    website: 'https://www.teambuildingtrainer.nl',
    inventarisatieformulier:
      'https://docs.google.com/forms/d/1NJWz0dyyJD5EurPCq-lYYR_5wk1hK6fnkeRKL9urF4E/viewform',
  },
  {
    code: 'FV',
    volledigeNaam: 'Firma Vitaliteit',
    kleur: '#A3DAC2',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.firmavitaliteit.nl/evaluatieformulier',
    website: 'https://www.firmavitaliteit.nl',
    inventarisatieformulier:
      'https://docs.google.com/forms/d/14SGRXQJcIHJFUz0vh4pqilOPd3SbKg0rJWdKcQaxcYg/viewform',
  },
  {
    code: 'SST',
    volledigeNaam: 'Soft Skill Trainer',
    kleur: '#0A2B58',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: 'https://www.softskilltrainer.nl/evaluatieformulier',
    website: 'https://www.softskilltrainer.nl',
    inventarisatieformulier:
      'https://docs.google.com/forms/d/1iCYVq4lEgTrBtjFQcSof7lLyGQR0r9EKLYG6t6BfR6s/viewform',
  },
  {
    code: 'WJ',
    volledigeNaam: 'WorkJoy',
    kleur: '#F78F44',
    term: 'Workshop',
    rapportterm: 'de workshop',
    evaluatieformulier: 'https://www.workjoy.nl/evaluatieformulier',
    website: 'https://www.workjoy.nl',
    inventarisatieformulier:
      'https://docs.google.com/forms/d/1JjqGw6Vpjd37j5W7_WBKxigr1BpfYJ740Z7pnZrIW4E/viewform',
  },
  {
    code: 'CC',
    volledigeNaam: 'Company Cursus',
    kleur: '#430521',
    term: 'Cursus',
    rapportterm: 'de cursus',
    evaluatieformulier: 'https://www.companycursus.nl/evaluatieformulier/',
    website: 'https://www.companycursus.nl',
    inventarisatieformulier: '',
  },
  {
    code: 'CP',
    volledigeNaam: 'Communicatie Plus',
    kleur: '#290F4B',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: 'https://www.communicatieplus.nl/evaluatieformulier/',
    website: 'https://www.communicatieplus.nl',
    inventarisatieformulier: '',
  },
  {
    code: 'FT',
    volledigeNaam: 'Feedback Trainer',
    kleur: '#265e5d',
    term: 'Training',
    rapportterm: 'de training',
    // Alle drie leeg en dat is geen omissie van ons. `feedbacktrainer.nl` gaf 403 op
    // 1-Sep-2026, en zowel `04-evaluatierapportage.md` als `06-briefing.md` vergeten FT in
    // hun opsomming. Eén vraag aan Dirkje, drie velden.
    evaluatieformulier: '',
    website: '',
    inventarisatieformulier: '',
  },
];

/**
 * Wat er op 1-Sep-2026 leeg blijft, met de reden — zodat een lege cel later niet als
 * "iemand heeft het weggehaald" wordt gelezen.
 */
export const LABEL_GAPS: Readonly<Record<string, string>> = {
  'FT.evaluatieformulier': 'ITG heeft er nooit een aangeleverd',
  'FT.website': 'feedbacktrainer.nl gaf 403; het echte adres is onbekend',
  'FT.inventarisatieformulier': 'ontbreekt in Dirkjes annotatie',
  'CC.inventarisatieformulier': 'ontbreekt in Dirkjes annotatie',
  'CP.inventarisatieformulier': 'ontbreekt in Dirkjes annotatie',
};
