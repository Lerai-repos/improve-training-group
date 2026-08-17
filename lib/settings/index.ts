/**
 * The Instellingen board — ITG's own copy of what used to be environment variables.
 *
 * `docs/build/03-aanbevelingsengine.md:105`: *"Alle bedragen en drempels komen uit het
 * Instellingen-board, nooit uit de code."* This module is that sentence, implemented.
 *
 * The layering, outermost first:
 *
 *   `board.ts`    which board to read, and why production may not be told otherwise
 *   `read.ts`     Monday → raw rows, fail-closed, coherence-gated
 *   `keys.ts`     row name → config key, normalised; unknown names are DATA, not errors
 *   `euros.ts`    the one place euros become cents, without ever touching a float
 *   `required.ts` a deleted row is a mistake, never a silent default
 *   `rates.ts`    the two tariff rows → the engine's rate cards
 *   `snapshot.ts` all of the above → one validated value handed to the engine
 */

export { INSTELLINGEN_PRODUCTION, resolveSettingsBoard, settingsBoardId } from './board';
export { createCachedSettings, SETTINGS_TTL_MS } from './cache';
export { createSettingsLoader, loadSettingsOnce } from './load';
export { eurosToCents } from './euros';
export { isKnownName, normaliseName, resolveSetting } from './keys';
export { buildRateCards, REQUIRED_RATE_KEYS } from './rates';
export { assertRequiredKeys, REQUIRED_APP_KEYS } from './required';
export { CATEGORIES, INITIAL_ROWS } from './initial-rows';
export type { InitialRow } from './initial-rows';
export { fetchGroepenLabels, readSettings, GROEPEN_COLUMN, SETTINGS_EXPECTED_COLUMNS } from './read';
export {
  activeOptionIds,
  deriveOptionMap,
  groepenOptions,
  parseOptionMap,
  priceableGroups,
  selectedGroupIds,
} from './groepen';
export { groepenKeyPrefix, provisionGroepselectie } from './provision-groepen';
export { buildSettingsSnapshot, provenanceOf } from './snapshot';

export type { DropdownLabel, DropdownSelection } from './groepen';
export type { ProvisionGroepenResult } from './provision-groepen';
export type { RawSettings, SettingsBoardConfig } from './read';
export type { ResolvedSetting } from './keys';
export type { SettingsLoaderDeps } from './load';
export type { SettingsProvenance, SettingsSnapshot, SnapshotOptions } from './snapshot';
