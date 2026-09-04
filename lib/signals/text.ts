import { FINDING_SOORT, findingKey } from './types';

import type { DesiredRow, Finding, LabelFieldIssue } from './types';

/**
 * De tekst van een melding: één regel als naam, een alinea als detail.
 *
 * Elke melding volgt dezelfde drie beats:
 *
 *   1. wat er aan de hand is,
 *   2. wat daardoor NIET gebeurt — het gemis is de reden dat dit een melding is,
 *   3. de twee manieren om hem te sluiten: repareren, of afvinken.
 *
 * Die derde beat staat er met opzet elke keer. Zonder een expliciet aangeboden "of vink dit af"
 * blijft een melding die nooit gerepareerd gaat worden voor altijd openstaan, en dan verzuipt
 * de rest erin. Thema's als "Massages" en "Stoelyoga" krijgen nooit briefinginhoud, en dat is
 * prima — maar dan moet iemand het één keer mogen zeggen.
 */

const AFVINKEN = 'Klopt dit zo, vink dit item dan af — dan meldt de controle het niet opnieuw.';

/** `kleur ongeldig, logo leeg` — kort genoeg voor in de itemnaam. */
function veldenLijst(velden: readonly LabelFieldIssue[]): string {
  return velden.map((v) => `${v.veld} ${v.reden}`).join(', ');
}

/**
 * Eén regel per onbruikbaar veld, mét de reparatie die erbij hoort.
 *
 * "Vul dit veld in" is geen bruikbare instructie voor een kleur waar `blauw` in staat — daar is
 * het veld juist wél ingevuld, alleen niet in een vorm die het rapport kan gebruiken.
 */
function veldRegel(issue: LabelFieldIssue): string {
  if (issue.reden === 'leeg') {
    return `  - ${issue.veld}: leeg — vul het in op het Labels-bord.`;
  }
  if (issue.veld === 'kleur') {
    return (
      '  - kleur: ingevuld, maar geen geldige kleurcode — noteer hem als #RRGGBB, ' +
      'bijvoorbeeld #0A2B58.'
    );
  }
  return `  - ${issue.veld}: ingevuld, maar niet bruikbaar — corrigeer de waarde.`;
}

/** Nederlandse meervoudsvorm voor het aantal trainingen in de kop. */
export function trainingen(n: number): string {
  return n === 1 ? '1 training' : `${n} trainingen`;
}

export function findingName(finding: Finding): string {
  switch (finding.kind) {
    case 'onbekend-label':
      return `Label "${finding.label}" is niet ingesteld — ${trainingen(finding.trainingen)}`;
    case 'label-ontbreekt':
      return `Label "${finding.code}" heeft geen rij op het Labels-bord — ${trainingen(finding.trainingen)}`;
    case 'label-onvolledig':
      /**
       * Het aantal trainingen én de reden per veld horen hier, ook al leest de zin er voller
       * door.
       *
       * De naam is de vingerafdruk waarmee `reconcile` ziet dat er iets is veranderd. Stond
       * alleen de veldenlijst hier, dan houdt een label dat van 7 naar 40 trainingen groeit
       * dezelfde naam, krijgt het geen update, en blijft het Detail 7 melden. Hetzelfde geldt
       * voor een kleur die van leeg naar ongeldig gaat: zelfde veld, ander probleem, andere
       * reparatie. Elke variant moet ál zijn veranderlijke waarden in de naam dragen —
       * `text.test.ts` bewaakt dat veld voor veld.
       */
      return (
        `Label "${finding.code}" is niet volledig ingesteld — ${veldenLijst(finding.velden)} — ` +
        trainingen(finding.trainingen)
      );
    case 'thema-ontbreekt':
      return `Thema ${finding.themaId} bestaat niet meer — ${trainingen(finding.trainingen)}`;
    case 'thema-zonder-inhoud':
      return `Thema "${finding.naam}" heeft geen concept-inhoud — ${trainingen(finding.trainingen)}`;
    case 'trainer-ontbreekt':
      return `Trainer ${finding.trainerId} bestaat niet meer — ${trainingen(finding.trainingen)}`;
  }
}

export function findingDetail(finding: Finding): string {
  switch (finding.kind) {
    case 'onbekend-label':
      return [
        `Op de agenda staan ${trainingen(finding.trainingen)} met label "${finding.label}". Die ` +
          'waarde staat niet op het Labels-bord en is ook geen bekende schrijfwijze van een ' +
          'bestaand label.',
        'Gevolg: voor deze trainingen wordt geen evaluatierapport en geen briefing gemaakt.',
        'Is dit een echt label? Zet het op het Labels-bord, met volledige naam, kleur, ' +
          'rapportterm, logo, voorblad en achterblad.',
        'Is het een schrijffout of een oud label? Pas de agenda aan. ' + AFVINKEN,
      ].join('\n\n');

    case 'label-ontbreekt':
      return [
        `"${finding.code}" is een bekend label — ${trainingen(finding.trainingen)} gebruiken het ` +
          '— maar er staat geen rij voor op het Labels-bord.',
        'Gevolg: voor deze trainingen wordt geen evaluatierapport gemaakt.',
        `Maak een rij "${finding.code}" aan op het Labels-bord en vul hem volledig in.`,
      ].join('\n\n');

    case 'label-onvolledig':
      return [
        `De rij "${finding.code}" staat op het Labels-bord, maar ${
          finding.velden.length === 1 ? 'één veld is' : `${finding.velden.length} velden zijn`
        } onbruikbaar:`,
        finding.velden.map(veldRegel).join('\n'),
        `Gevolg: het rapport voor de ${trainingen(finding.trainingen)} met dit label kan niet ` +
          'in de huisstijl worden opgemaakt.',
      ].join('\n\n');

    case 'thema-ontbreekt':
      return [
        `${trainingen(finding.trainingen)} verwijzen naar thema-item ${finding.themaId}, en dat ` +
          "item bestaat niet meer op het Thema's-bord.",
        'Dit gebeurt als een thema wordt verwijderd en opnieuw aangemaakt: het nieuwe item heeft ' +
          'een ander id, en de geschiedenis blijft achter bij het oude. De statistiek van dit ' +
          'thema splitst daardoor in tweeën, zonder foutmelding.',
        'Laat dit door Lerai herstellen — de trainingen moeten aan het levende thema worden ' +
          'gekoppeld. Verwijder en hermaak geen thema; hernoemen is wél veilig.',
      ].join('\n\n');

    case 'trainer-ontbreekt':
      return [
        `${trainingen(finding.trainingen)} verwijzen naar trainer-item ${finding.trainerId}, en ` +
          'dat item bestaat niet meer op het trainersbord.',
        'Dit gebeurt als een trainer wordt verwijderd en opnieuw aangemaakt: het nieuwe item ' +
          'heeft een ander id, en alle evaluaties en gegeven trainingen blijven achter bij het ' +
          'oude. De statistiek van die trainer splitst daardoor in tweeën, zonder foutmelding.',
        'Laat dit door Lerai herstellen — de trainingen moeten aan het levende trainer-item ' +
          'worden gekoppeld. Verwijder en hermaak geen trainer; hernoemen is wél veilig.',
      ].join('\n\n');

    case 'thema-zonder-inhoud':
      return [
        `Het thema "${finding.naam}" staat op het Thema's-bord, maar de kolom Concept inhoud is ` +
          `leeg. ${trainingen(finding.trainingen)} gebruiken dit thema.`,
        'Gevolg: in de briefing komt op die plek de regel «nog niet aangesloten: concept-inhoud» ' +
          'te staan in plaats van de bullets, en de briefing telt als niet af.',
        "Vul de standaardbullets in op het Thema's-bord. Heeft dit thema helemaal geen briefing " +
          'nodig? ' +
          AFVINKEN,
      ].join('\n\n');
  }
}

/** Welke job dit gevonden heeft — de kolom Onderdeel. */
export function findingOnderdeel(finding: Finding): string {
  switch (finding.kind) {
    case 'onbekend-label':
    case 'label-ontbreekt':
    case 'label-onvolledig':
      return 'Labelconfiguratie';
    case 'thema-ontbreekt':
    case 'thema-zonder-inhoud':
      return "Thema's";
    case 'trainer-ontbreekt':
      return 'Trainers';
  }
}

/** De sleutelprefix van een mislukte controle. Eén rij per controle, niet per foutmelding. */
export const FAILURE_PREFIX = 'controle-mislukt';

export const failureKey = (check: string): string => `${FAILURE_PREFIX}:${check}`;

/**
 * De bordrij voor een controle die niet kon draaien.
 *
 * `Soort` is `Foutmelding` en niet `Signalering`, en dat onderscheid is de hele reden dat deze
 * rij bestaat: een vondst is een toestand van ITG's gegevens, een mislukte controle is een
 * storing bij ons. Wie het bord filtert op Foutmelding wil precies dit zien — en zag tot nu toe
 * niets, omdat een storing alleen in de tekst van de dagsamenvatting stond.
 *
 * **De naam bevat de foutmelding met opzet NIET.** De naam is de vingerafdruk waarop een rij
 * wordt bijgewerkt, en foutteksten wisselen per poging (andere id, ander tijdstip). Zou de
 * boodschap erin staan, dan werd deze rij tijdens een storing elke nacht herschreven. Wat
 * telt is "deze controle ligt eruit"; de nieuwste tekst staat in de samenvattingsrij.
 */
export function rowForFailure(failure: { check: string; error: string }): DesiredRow {
  return {
    key: failureKey(failure.check),
    naam: `Controle "${failure.check}" kon niet draaien`,
    onderdeel: 'Dagelijkse controle',
    soort: 'Foutmelding',
    // De naam is stabiel, dus zonder dit blijft de foutmelding hieronder op de éérste hangen.
    refreshDetail: true,
    detail: [
      `De controle "${failure.check}" is deze run niet gelukt. Zolang dat zo is worden er voor ` +
        'dit onderdeel geen meldingen geplaatst én geen bestaande meldingen opgeruimd — er kan ' +
        'dus iets misstaan zonder dat het bord het laat zien.',
      `Laatste foutmelding: ${failure.error}`,
      'Deze rij verdwijnt vanzelf zodra de controle weer draait, en de foutmelding hierboven ' +
        'wordt elke run bijgewerkt.',
    ].join('\n\n'),
  };
}

/** De bordrij voor één vondst. */
export function rowForFinding(finding: Finding): DesiredRow {
  return {
    key: findingKey(finding),
    naam: findingName(finding),
    detail: findingDetail(finding),
    onderdeel: findingOnderdeel(finding),
    soort: FINDING_SOORT,
    // De naam draagt alle veranderlijke waarden; het Detail mag iemands aantekening bevatten.
    refreshDetail: false,
  };
}
