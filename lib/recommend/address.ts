import { z } from 'zod';

/**
 * Address formatting/classification for the travel step. The result is a
 * DISCRIMINATED union — malformed model output or an unknown physical location is
 * NEVER silently turned into "no travel". Only a CONFIRMED online training yields
 * the zero-travel path; a vague/unknown physical location is `unresolved_location`
 * and an LLM/parse failure is `error` — both drive FOUT upstream.
 */

export type AddressDecision =
  | { kind: 'travel_required'; formatted: string }
  | { kind: 'no_travel_confirmed'; reason: 'online' }
  | { kind: 'unresolved_location'; detail: string }
  | { kind: 'error'; detail: string };

export interface AddressFormatter {
  format(rawLocation: string | null): Promise<AddressDecision>;
}

/** A single classification call: given system+user text, return the model's raw text. */
export type Completion = (prompt: { system: string; user: string }) => Promise<string>;

export const ADDRESS_MODEL = 'anthropic/claude-haiku-4.5';
export const ADDRESS_PROMPT_VERSION = 'v1';

export const ADDRESS_SYSTEM_PROMPT = [
  'You classify a Dutch training location for driving-distance lookup.',
  'Respond with ONLY a JSON object (no prose) of the form:',
  '{"outcome":"travel_required"|"online"|"unresolved","formatted":string|null,"reason":string|null}',
  '- "travel_required": a real physical address/place; put a Google-Maps-ready address in "formatted".',
  '- "online": the training is explicitly online/remote (Teams, Zoom, "online", "digitaal").',
  '- "unresolved": a vague/unknown physical location ("locatie volgt", "ergens in Utrecht", province only).',
  'Never guess an address you are not confident about — use "unresolved" instead.',
].join('\n');

const rawSchema = z.object({
  outcome: z.enum(['travel_required', 'online', 'unresolved']),
  formatted: z.string().nullish(),
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
    const { outcome, formatted, reason } = parsed.data;
    if (outcome === 'online') {
      return { kind: 'no_travel_confirmed', reason: 'online' };
    }
    if (outcome === 'unresolved') {
      return { kind: 'unresolved_location', detail: reason ?? 'unresolved' };
    }
    if (formatted && formatted.trim() !== '') {
      return { kind: 'travel_required', formatted: formatted.trim() };
    }
    return { kind: 'unresolved_location', detail: 'travel_required without a formatted address' };
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
