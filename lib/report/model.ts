import { chartColours } from './colours';
import {
  answeredCount,
  averageLabel,
  bars,
  followUpTally,
  gradeDistribution,
  scoreDistribution,
} from './distribution';
import { firstNames, joinDutch, trainerWord } from './text';

import type { ChartModel, PieSlice, ReportInput, ReportModel } from './types';
import type { EvaluationResponse } from '@lib/evaluations/types';

/**
 * Van ruwe responses naar precies wat er in het document komt te staan.
 *
 * De vraagteksten staan hier LETTERLIJK zoals ze in het formulier staan, want dat is wat er
 * boven elke grafiek hoort — de deelnemer heeft die zin beantwoord, niet een samenvatting
 * ervan. Ze komen bewust niet uit `header-map.ts`: dat bestand koppelt kolommen en mag
 * meebewegen met een formulierwijziging; deze teksten zijn de rapportcopy.
 */

const AXIS_1_5 = ['1', '2', '3', '4', '5'];
const AXIS_1_10 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const FULL_CIRCLE = 360;

const TRAINING_QUESTIONS = [
  {
    text: 'Hoe heb je het programma inhoudelijk (bijv. structuur, werkvormen, genoeg uitdaging) ervaren?',
    of: (r: EvaluationResponse): number | null => r.answers.program,
  },
  {
    text: 'Vind je dat er in voldoende mate praktijkgericht en actief gewerkt is?',
    of: (r: EvaluationResponse): number | null => r.answers.practical,
  },
  {
    text: 'Heeft de sessie concrete handvatten geboden om zelf mee aan de slag te kunnen?',
    of: (r: EvaluationResponse): number | null => r.answers.tools,
  },
] as const;

const TRAINER_QUESTIONS = [
  {
    text: 'Vond je de trainer vakkundig, bekwaam en in staat om het onderwerp te behandelen?',
    of: (r: EvaluationResponse): number | null => r.answers.trainerExpertise,
  },
  {
    text: 'Hoe heb je de communicatie en omgang van de trainer ervaren?',
    of: (r: EvaluationResponse): number | null => r.answers.trainerCommunication,
  },
] as const;

const GRADE_QUESTION = 'Welk eindcijfer zou je de sessie geven?';
const FOLLOW_UP_QUESTION = 'Lijkt het je waardevol om in een opvolgsessie te verdiepen?';

/**
 * "12 antwoorden, gemiddelde score: 4.3".
 *
 * Zonder antwoorden vervalt het gemiddelde in plaats van er `null` of `NaN` te tonen — dat
 * laatste is precies wat er in een klantdocument nooit mag staan.
 */
function subtitleFor(values: readonly (number | null)[]): string {
  const count = answeredCount(values);
  const average = averageLabel(values);
  if (count === 0 || average === null) {
    return 'Geen antwoorden op deze vraag';
  }
  return `${count} antwoorden, gemiddelde score: ${average}`;
}

function chartFor(
  question: string,
  values: readonly (number | null)[],
  scale: 'score' | 'grade'
): ChartModel {
  const distribution = scale === 'grade' ? gradeDistribution(values) : scoreDistribution(values);
  return {
    question,
    subtitle: subtitleFor(values),
    bars: bars(distribution).map((b) => ({ pct: b.pct, label: b.label })),
    axis: scale === 'grade' ? AXIS_1_10 : AXIS_1_5,
  };
}

/**
 * De taartpunten als één `conic-gradient`.
 *
 * Server-side uitgerekend, net als de balkhoogtes. De bestaande generator zet dit met
 * JavaScript ná het laden; in een PDF-render is dat een wedloop tussen dat script en het
 * moment van vastleggen, en die hoeven we niet aan te gaan.
 */
function pieGradient(slices: readonly PieSlice[]): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return '';
  }
  let acc = 0;
  const parts = slices.map((slice) => {
    const start = (acc / total) * FULL_CIRCLE;
    acc += slice.value;
    const end = (acc / total) * FULL_CIRCLE;
    return `${slice.colour} ${start}deg ${end}deg`;
  });
  return `conic-gradient(from -90deg, ${parts.join(', ')})`;
}

/** Niet-lege citaten, in de volgorde waarin ze binnenkwamen. */
function quotes(
  responses: readonly EvaluationResponse[],
  pick: (r: EvaluationResponse) => string | null
): string[] {
  return responses.map((r) => (pick(r) ?? '').trim()).filter((text) => text !== '');
}

export function buildReportModel(input: ReportInput): ReportModel {
  const { training, label, responses } = input;
  const colours = chartColours(label.kleur);

  const voornamen = firstNames(training.contactPersoon);
  const trainerVoornamen = training.trainerNamen.map((n) => n.trim().split(/\s+/)[0] ?? '');
  const trainerString = joinDutch(trainerVoornamen);
  const woord = trainerWord(trainerVoornamen.filter((n) => n !== '').length);
  const term = label.rapportterm;

  const grades = responses.map((r) => r.grade);
  const tally = followUpTally(responses.map((r) => r.answers.followUp));

  const slices: PieSlice[] = [
    { label: 'Ja', value: tally.ja, colour: colours.mid },
    { label: 'Nee', value: tally.nee, colour: colours.light },
    { label: 'Anders', value: tally.anders, colour: colours.lightest },
  ];

  return {
    contactNamen: joinDutch(voornamen),
    trainerNamen: trainerString,
    klanttitel: training.klanttitel,
    rapportterm: term,
    labelNaam: label.volledigeNaam,
    trainerWoord: woord,
    gemiddeldeBeoordeling: averageLabel(grades),
    aantalRespondenten: responses.length,
    cijferChart: chartFor(GRADE_QUESTION, grades, 'grade'),
    trainingCharts: TRAINING_QUESTIONS.map((q) => chartFor(q.text, responses.map(q.of), 'score')),
    trainerCharts: TRAINER_QUESTIONS.map((q) => chartFor(q.text, responses.map(q.of), 'score')),
    followUp: {
      subtitle:
        tally.total === 0
          ? 'Geen antwoorden op deze vraag'
          : `${tally.total} antwoorden, aantal keer ja: ${tally.ja}`,
      slices,
      gradient: pieGradient(slices),
    },
    positieveCitaten: quotes(responses, (r) => r.answers.positive),
    verbeterCitaten: quotes(responses, (r) => r.answers.improvement),
  };
}

export { FOLLOW_UP_QUESTION };
