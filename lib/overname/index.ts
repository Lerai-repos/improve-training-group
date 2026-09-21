/**
 * Overname uit de Opportunity: de antwoorden op voorbereidende opdracht, huiswerk en
 * trainingscyclus die de accountmanager al in de Opportunity-fase geeft, 's nachts overnemen
 * op de lege cellen van de komende trainingen. Zie `run.ts` voor de afspraak met Dirkje.
 */
export { AGENDA_LABELS, OPPORTUNITY_LABELS, OPPORTUNITY_OVERNAME_COLUMNS } from './columns';
export { buildOvernameDeps, vandaagNL } from './deps';
export { herleesKandidaat, readKandidaten, readOpportunities, type Kandidaat } from './read';
export {
  bepaalOvername,
  type AgendaStand,
  type Conflict,
  type Kolomwaarden,
  type OpportunityStand,
  type Overname,
} from './regel';
export {
  runOvername,
  type Mislukking,
  type OvernameDeps,
  type OvernameReport,
  type Schrijfactie,
  type TrainingConflict,
} from './run';
