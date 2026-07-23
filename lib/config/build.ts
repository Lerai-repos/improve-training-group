import { appConfigSchema, type AppConfig } from './schema';
import { CONFIG_DEFAULTS } from './defaults';

/** A config key/value pair, as stored in the `config` table. */
export interface ConfigRowLike {
  key: string;
  value: string;
}

interface FieldSpec {
  dbKey: string;
  /** Financial keys must be present in production — no silent default. */
  financial: boolean;
  parse: (raw: string) => unknown;
}

const asString = (s: string): string => s;
const asNumber = (s: string): number => Number(s);

const FIELD_SPECS: Record<keyof AppConfig, FieldSpec> = {
  hqAddress: { dbKey: 'HQ_ADRES', financial: false, parse: asString },
  evaluationThresholdHours: {
    dbKey: 'THRESHOLD_HOURS',
    financial: false,
    parse: asNumber,
  },
  travelRateTrainerCentsPerKm: {
    dbKey: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM',
    financial: true,
    parse: asNumber,
  },
  travelRateClientCentsPerKm: {
    dbKey: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM',
    financial: true,
    parse: asNumber,
  },
  travelTimeThresholdMinutes: {
    dbKey: 'TRAVEL_TIME_THRESHOLD_MINUTES',
    financial: false,
    parse: asNumber,
  },
  travelTimeMode: { dbKey: 'TRAVEL_TIME_MODE', financial: false, parse: asString },
  travelTimeFeePerMinuteCents: {
    dbKey: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS',
    financial: true,
    parse: asNumber,
  },
  mondayApiVersion: {
    dbKey: 'MONDAY_API_VERSION',
    financial: false,
    parse: asString,
  },
};

const FIELDS = Object.keys(FIELD_SPECS) as (keyof AppConfig)[];

/**
 * Build validated {@link AppConfig} from raw config rows.
 *
 * - DB value wins; a missing key falls back to {@link CONFIG_DEFAULTS} …
 * - … EXCEPT a financial key missing in production throws (no silent money default).
 * - The assembled object is Zod-validated, so a malformed value also throws.
 *
 * Pure: no I/O, no cache, no env reads (production-ness is passed in).
 */
export function buildAppConfig(
  rows: readonly ConfigRowLike[],
  opts: { isProduction: boolean }
): AppConfig {
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const missingFinancial: string[] = [];
  const raw: Record<string, unknown> = {};

  for (const field of FIELDS) {
    const spec = FIELD_SPECS[field];
    const value = map.get(spec.dbKey);
    if (value !== undefined) {
      raw[field] = spec.parse(value);
    } else if (spec.financial && opts.isProduction) {
      missingFinancial.push(spec.dbKey);
    } else {
      raw[field] = CONFIG_DEFAULTS[field];
    }
  }

  if (missingFinancial.length > 0) {
    throw new Error(
      `Missing required financial config in production: ${missingFinancial.join(', ')}`
    );
  }

  return appConfigSchema.parse(raw);
}
