import { eurosToCents } from './euros';

import type { ConfigRowLike } from '@lib/config';

/**
 * Instellingen board row → the key/value row `buildAppConfig` already understands.
 *
 * The item NAME is the key. That is a deliberate copy of Airtable's `Configurarie`, so
 * ITG recognises the board on day one — but it means the key is free text on a board
 * anyone can edit, which is why every lookup goes through {@link normaliseName} first.
 *
 * Two things this module does NOT do, both on purpose:
 *
 * 1. **It does not decide what an unknown name means.** It reports `unknown` and lets
 *    the reader apply the `Notities`-group rule. Throwing here would make every note
 *    somebody types a configuration outage — see `read.ts`.
 * 2. **It does not check that required keys are present.** That is `required.ts`, which
 *    needs the whole board to answer.
 */

/** Cohort rate keys, matching `GROUP_POLICY` in `board-config.ts`. */
const RATE_2020_2024 = '2020-2024';
const RATE_2024_HEDEN = '2024-heden';

/**
 * Fold everything a human might vary while meaning the same key: case, leading and
 * trailing space, runs of whitespace, and the separators people paste in from env
 * variables (`HQ_ADRES`) or type by habit (`HQ-ADRES`).
 *
 * Without this a stray double space reads as a DIFFERENT name, which resolves to
 * `unknown`, which — for a name that is not in `Notities` — takes the config down.
 */
export function normaliseName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Whole minutes. Not money, so not `eurosToCents` — and not a float either. */
function wholeMinutes(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Ongeldig aantal minuten "${raw}" — verwacht een heel getal, bijvoorbeeld 90`);
  }
  return String(Number(trimmed));
}

const asIs = (value: string): string => value;
const asCents = (value: string): string => String(eurosToCents(value));

interface AppSpec {
  kind: 'app';
  dbKey: string;
  parse: (value: string) => string;
}

interface RateSpec {
  kind: 'rate';
  rateKey: string;
}

type Spec = AppSpec | RateSpec;

/**
 * Board name → what it means. Keyed by the NORMALISED name.
 *
 * The two `TRAVEL TIME …` entries are the legacy Airtable spellings, kept as aliases so
 * a row recreated by hand from the old table resolves instead of reading as unknown.
 */
const SPECS = new Map<string, Spec>([
  [normaliseName('HQ ADRES'), { kind: 'app', dbKey: 'HQ_ADRES', parse: asIs }],
  [
    normaliseName('REISTARIEF TRAINERS'),
    { kind: 'app', dbKey: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM', parse: asCents },
  ],
  [
    normaliseName('REISTARIEF HQ'),
    { kind: 'app', dbKey: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM', parse: asCents },
  ],
  [
    normaliseName('REISTIJD DREMPEL'),
    { kind: 'app', dbKey: 'TRAVEL_TIME_THRESHOLD_MINUTES', parse: wholeMinutes },
  ],
  [
    normaliseName('TRAVEL TIME THRESHOLD'),
    { kind: 'app', dbKey: 'TRAVEL_TIME_THRESHOLD_MINUTES', parse: wholeMinutes },
  ],
  [
    normaliseName('REISTIJD VERGOEDING'),
    { kind: 'app', dbKey: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', parse: asCents },
  ],
  [
    normaliseName('TRAVEL TIME FEE'),
    { kind: 'app', dbKey: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', parse: asCents },
  ],
  [
    normaliseName('TRAINERGROEPEN'),
    { kind: 'app', dbKey: 'RECOMMENDABLE_TRAINER_GROUPS', parse: asIs },
  ],
  [normaliseName('TARIEF 2020 - 2024'), { kind: 'rate', rateKey: RATE_2020_2024 }],
  [normaliseName('TARIEF 2024 - HEDEN'), { kind: 'rate', rateKey: RATE_2024_HEDEN }],
]);

export type ResolvedSetting =
  | { kind: 'app'; row: ConfigRowLike }
  | { kind: 'rate'; rateKey: string; hourlyRateCents: number }
  /** Not a name we know. The CALLER decides whether that is fatal. */
  | { kind: 'unknown' };

/** Is this a name we own? Used by the reader to police the `Notities` group. */
export function isKnownName(name: string): boolean {
  return SPECS.has(normaliseName(name));
}

/**
 * Resolve one board row. Throws only when the name IS ours and the value is malformed —
 * an unrecognised name is data, not an error, at this level.
 */
export function resolveSetting(name: string, value: string): ResolvedSetting {
  const spec = SPECS.get(normaliseName(name));
  if (spec === undefined) {
    return { kind: 'unknown' };
  }
  if (spec.kind === 'rate') {
    return { kind: 'rate', rateKey: spec.rateKey, hourlyRateCents: eurosToCents(value) };
  }
  return { kind: 'app', row: { key: spec.dbKey, value: spec.parse(value) } };
}
