/**
 * Het inventarisatieformulier: de link op elke Opportunity (`https://www.<label>/inventarisatie
 * ?reference_id=<Opportunity>`), zodra de Opportunity er is. Zie `link.ts` voor de afspraak.
 */
export { buildInventarisatieDeps, linkWaarde } from './deps';
export { gewensteLink, inventarisatieLink, labelVanOpportunity } from './link';
export {
  syncAlleLinks,
  syncLink,
  type InventarisatieDeps,
  type LinkRapport,
  type LinkUitkomst,
  type OpportunityStand,
} from './run';
export {
  parseInventarisatieWebhook,
  verwerkInventarisatieWebhook,
  type InventarisatieWebhook,
} from './webhook';
