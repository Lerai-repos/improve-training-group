/**
 * Config layer. Values arrive as key/value rows and are typed, validated and
 * defaulted here — the SOURCE is deliberately swappable: they came from a Postgres
 * `config` table, they now come from the environment, and the Monday Instellingen
 * board is next.
 *
 * Financial config missing in production is a hard error, never a silent default —
 * see the `financial` flag in `build.ts`.
 */
export { appConfigSchema, type AppConfig } from './schema';
export { CONFIG_DEFAULTS } from './defaults';
export { buildAppConfig, type ConfigRowLike } from './build';
