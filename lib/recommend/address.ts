import { z } from 'zod';

/**
 * Address formatting/classification for the travel step. The result is a
 * DISCRIMINATED union — malformed model output or an unknown physical location is
 * NEVER silently turned into "no travel". Only a CONFIRMED online training yields
 * the zero-travel path; a vague/unknown physical location is `unresolved_location`
 * and an LLM/parse failure is `error` — both drive FOUT upstream.
 */

/** `exact` = a street address. `city` = a town centre, so every distance is a guess. */
export type TravelPrecision = 'exact' | 'city';

export type AddressDecision =
  /**
   * `city` is decoration, never a decision. It exists so the WhatsApp message can say
   * "Amsterdam" where legacy did, instead of the full street address; nothing about
   * travel, pricing or ranking reads it. It is nullable for exactly that reason — see
   * the parse below, where a malformed city must not cost us a good classification.
   */
  | {
      kind: 'travel_required';
      formatted: string;
      city: string | null;
      /**
       * How exactly the destination is known — a real decision, unlike `city`.
       *
       * `city` means ITG typed only a town ("Rotterdam", "Utrecht, Nederland"), so every
       * distance is measured to that town's centre. Google answers such a query happily,
       * which is exactly the danger: the kilometres come back looking as measured as any
       * other, and they feed the travel cost and therefore the ranking. Carrying the
       * difference lets the list say it is an estimate instead of quietly presenting one
       * as fact.
       */
      precision: TravelPrecision;
    }
  | { kind: 'no_travel_confirmed'; reason: 'online' }
  | { kind: 'unresolved_location'; detail: string }
  | { kind: 'error'; detail: string };

export interface AddressFormatter {
  format(rawLocation: string | null): Promise<AddressDecision>;
}

/** A single classification call: given system+user text, return the model's raw text. */
export type Completion = (prompt: { system: string; user: string }) => Promise<string>;

export const ADDRESS_MODEL = 'anthropic/claude-haiku-4.5';
/**
 * `v2` added `city`. `v3` added `city_only`, which changes what the same input means.
 *
 * NOT provenance only, despite what this comment used to claim: it is the second half of
 * the city cache's key (`cityStore.remember`/`lookup`) as well as a field in the stored
 * artifact. Both readings depend on the bump. A town like "Rotterdam" classified under v2
 * produced no usable answer at all, and leaving the version alone would keep serving those
 * v2 entries against a prompt that now resolves them — and would make a run from before
 * this change indistinguishable from one after it in the artifact.
 */
export const ADDRESS_PROMPT_VERSION = 'v3';

/** A city name is a city name; anything longer is the model misunderstanding the field. */
export const CITY_MAX_LENGTH = 120;

export const ADDRESS_SYSTEM_PROMPT = [
  'You classify a Dutch training location for driving-distance lookup.',
  'Respond with ONLY a JSON object (no prose) of the form:',
  '{"outcome":"travel_required"|"city_only"|"online"|"unresolved","formatted":string|null,"city":string|null,"reason":string|null}',
  '- "travel_required": a real street address or a named venue that identifies one place;',
  '  put a Google-Maps-ready address in "formatted".',
  '- "city_only": a town or city with no street ("Rotterdam", "Utrecht, Nederland", "Omgeving Utrecht").',
  '  Put the town in "formatted" so distances can be measured to its centre.',
  '- "city": just the town or city of that address ("Boxmeer" for "Raadhuisplein 1, 5831 JX Boxmeer",',
  '  "Utrecht" for "Omgeving Utrecht"). Null if you cannot tell. Never invent one.',
  '- "online": the training is explicitly online/remote (Teams, Zoom, "online", "digitaal").',
  '- "unresolved": no usable place at all ("locatie volgt", "nader te bepalen", a province,',
  '  a region that is not one town).',
  'Never guess an address you are not confident about — use "city_only" when you know the town',
  'but not the street, and "unresolved" when you do not even know the town.',
].join('\n');

const rawSchema = z.object({
  /**
   * `city_only` is its own outcome rather than a separate `precision` field, and that is
   * deliberate.
   *
   * A boolean beside `travel_required` would need a default, and both defaults are wrong:
   * defaulting to exact lets a model that forgot the field present a town-centre guess as
   * a measured distance, while defaulting to city marks every ordinary address as an
   * estimate the moment the field goes missing. As an outcome there is nothing to
   * default — a model that does not know the word answers `unresolved`, which is exactly
   * what happened before this existed.
   */
  outcome: z.enum(['travel_required', 'city_only', 'online', 'unresolved']),
  formatted: z.string().nullish(),
  /**
   * Every link in this chain is load-bearing, and the obvious spellings are wrong.
   *
   * A bare `.nullish()` makes `{"city":42}` fail the WHOLE object, turning a perfectly
   * good classification into an `error` decision and a retryable FOUT — a decoration
   * costing us the answer. `.catch(null)` fixes the wrong-type case but not the missing
   * one: `undefined` is *valid* for `nullish()`, so the catch never runs and the field
   * survives as `undefined`. The `.transform` is what actually normalises absence.
   */
  city: z
    .string()
    .trim()
    .min(1)
    .max(CITY_MAX_LENGTH)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  reason: z.string().nullish(),
});

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map the model's raw text to an {@link AddressDecision}. Fenced JSON is stripped;
 * a missing object, schema mismatch, or parse throw → `error` (never no-travel).
 */
export function parseAiResponse(text: string): AddressDecision {
  try {
    const cleaned = text
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return { kind: 'error', detail: 'no JSON object in response' };
    }
    const parsed = rawSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) {
      return { kind: 'error', detail: `schema: ${parsed.error.message}` };
    }
    const { outcome, formatted, city, reason } = parsed.data;
    if (outcome === 'online') {
      return { kind: 'no_travel_confirmed', reason: 'online' };
    }
    if (outcome === 'unresolved') {
      return { kind: 'unresolved_location', detail: reason ?? 'unresolved' };
    }
    if (formatted && formatted.trim() !== '') {
      return {
        kind: 'travel_required',
        formatted: formatted.trim(),
        /**
         * For a town-only location the town IS the address, so fall back to `formatted`
         * rather than letting the WhatsApp message lose the one thing we do know.
         */
        city: outcome === 'city_only' ? (city ?? formatted.trim()) : city,
        precision: outcome === 'city_only' ? 'city' : 'exact',
      };
    }
    // Including `city_only`: a town we cannot even name is not a destination.
    return { kind: 'unresolved_location', detail: `${outcome} without a formatted address` };
  } catch (e) {
    return { kind: 'error', detail: `parse: ${errMessage(e)}` };
  }
}

/**
 * Build a formatter over an injected {@link Completion} transport. An empty/blank
 * location is `unresolved_location` (unknown travel, not zero); a transport throw
 * is `error` (→ retry → FOUT). The Claude/OpenRouter transport is wired separately.
 */
export function createAddressFormatter(complete: Completion): AddressFormatter {
  return {
    async format(rawLocation: string | null): Promise<AddressDecision> {
      if (!rawLocation || rawLocation.trim() === '') {
        return { kind: 'unresolved_location', detail: 'empty location' };
      }
      let text: string;
      try {
        text = await complete({ system: ADDRESS_SYSTEM_PROMPT, user: rawLocation.trim() });
      } catch (e) {
        return { kind: 'error', detail: `llm call failed: ${errMessage(e)}` };
      }
      return parseAiResponse(text);
    },
  };
}

/** A fixed-decision formatter for tests / no-travel paths. */
export function createStubAddressFormatter(decision: AddressDecision): AddressFormatter {
  return {
    format(): Promise<AddressDecision> {
      return Promise.resolve(decision);
    },
  };
}
