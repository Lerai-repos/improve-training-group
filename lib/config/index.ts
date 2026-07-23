/**
 * Config layer. Non-financial operational settings live in the `config` table
 * (typed, validated, cached, source-swappable to Monday later); hourly rates
 * live in `rate_cards` (effective-dated). Financial config missing in production
 * is a hard error, never a silent default.
 */
export { appConfigSchema, type AppConfig } from './schema';
export { CONFIG_DEFAULTS } from './defaults';
export { buildAppConfig, type ConfigRowLike } from './build';
export { getAppConfig, clearConfigCache } from './config';
export { getRateCards, mapRateCardRow } from './rate-cards';
