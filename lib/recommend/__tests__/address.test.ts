import { describe, expect, it } from 'vitest';

import { createAddressFormatter, parseAiResponse, type Completion } from '../address';

describe('parseAiResponse', () => {
  it('travel_required with a formatted address', () => {
    const d = parseAiResponse(
      '{"outcome":"travel_required","formatted":"Wolvenplein 25, Utrecht","city":"Utrecht"}'
    );
    expect(d).toEqual({
      kind: 'travel_required',
      formatted: 'Wolvenplein 25, Utrecht',
      city: 'Utrecht',
      precision: 'exact',
    });
  });

  /**
   * `city` is decoration on a decision that governs money. It must never be able to cost
   * us the decision — so these assert on `formatted` and `kind`, not on the city.
   *
   * The hazard is real and specific: with a bare `z.string().nullish()`, `"city":42`
   * fails the whole object, `parseAiResponse` returns `error`, and `service.ts` turns a
   * good classification into a retryable FOUT. A field nobody prices would take the run
   * down.
   */
  describe('a malformed city never invalidates the classification', () => {
    it.each([
      ['a number', '{"outcome":"travel_required","formatted":"X 1","city":42}'],
      ['an object', '{"outcome":"travel_required","formatted":"X 1","city":{"name":"Utrecht"}}'],
      ['an array', '{"outcome":"travel_required","formatted":"X 1","city":["Utrecht"]}'],
      ['a blank string', '{"outcome":"travel_required","formatted":"X 1","city":"   "}'],
      [
        'an absurd length',
        `{"outcome":"travel_required","formatted":"X 1","city":"${'x'.repeat(500)}"}`,
      ],
    ])('%s becomes null and leaves the rest intact', (_label, raw) => {
      expect(parseAiResponse(raw)).toEqual({
        kind: 'travel_required',
        formatted: 'X 1',
        city: null,
        precision: 'exact',
      });
    });

    /** `undefined` is *valid* for nullish(), so `.catch` never fires — `.transform` does. */
    it('normalises a missing city to null rather than undefined', () => {
      const d = parseAiResponse('{"outcome":"travel_required","formatted":"X 1"}');

      expect(d).toEqual({
        kind: 'travel_required',
        formatted: 'X 1',
        city: null,
        precision: 'exact',
      });
      expect(d.kind === 'travel_required' && 'city' in d && d.city === null).toBe(true);
    });

    it('trims a city the model padded', () => {
      const d = parseAiResponse(
        '{"outcome":"travel_required","formatted":"X 1","city":" Boxmeer "}'
      );
      expect(d).toMatchObject({ city: 'Boxmeer' });
    });

    /** An online training has no city, and asking for one would be inventing it. */
    it('carries no city on the zero-travel path', () => {
      expect(parseAiResponse('{"outcome":"online","city":"Utrecht"}')).toEqual({
        kind: 'no_travel_confirmed',
        reason: 'online',
      });
    });
  });

  it('online → the only zero-travel path', () => {
    expect(parseAiResponse('{"outcome":"online","formatted":null}')).toEqual({
      kind: 'no_travel_confirmed',
      reason: 'online',
    });
  });

  /**
   * ITG's own request: a training whose Locatie says only "Rotterdam" used to produce no
   * recommendations at all. Google will happily route to a town, so refusing was stricter
   * than it needed to be — the answer is to accept it and say that it is an estimate.
   */
  describe('a town with no street', () => {
    it('is a destination, marked as measured to the centre', () => {
      expect(
        parseAiResponse('{"outcome":"city_only","formatted":"Rotterdam","city":"Rotterdam"}')
      ).toEqual({
        kind: 'travel_required',
        formatted: 'Rotterdam',
        city: 'Rotterdam',
        precision: 'city',
      });
    });

    /** For a town-only location the town IS the address — never lose it to a null city. */
    it('falls back to the formatted town when the model names no city', () => {
      const d = parseAiResponse('{"outcome":"city_only","formatted":"Utrecht"}');
      expect(d).toEqual({
        kind: 'travel_required',
        formatted: 'Utrecht',
        city: 'Utrecht',
        precision: 'city',
      });
    });

    /** A town we cannot even name is not a destination, whatever the outcome says. */
    it('is unresolved when there is no town to route to', () => {
      expect(parseAiResponse('{"outcome":"city_only","formatted":""}')).toEqual({
        kind: 'unresolved_location',
        detail: 'city_only without a formatted address',
      });
    });

    /**
     * The reason `city_only` is an OUTCOME and not a boolean beside `travel_required`.
     *
     * A model that does not know the word cannot accidentally present a town-centre guess
     * as an exact address — the enum rejects it, and the run fails the way it did before
     * this existed rather than quietly claiming a precision it does not have.
     */
    it('never lets an unknown outcome pass as an exact address', () => {
      expect(parseAiResponse('{"outcome":"city","formatted":"Rotterdam"}').kind).toBe('error');
    });
  });

  it('vague/unknown physical location → unresolved (FOUT), NOT zero', () => {
    const d = parseAiResponse('{"outcome":"unresolved","reason":"locatie volgt"}');
    expect(d).toEqual({ kind: 'unresolved_location', detail: 'locatie volgt' });
  });

  it('travel_required without a formatted address → unresolved (never zero)', () => {
    expect(parseAiResponse('{"outcome":"travel_required","formatted":""}').kind).toBe(
      'unresolved_location'
    );
  });

  it('strips markdown fences', () => {
    const d = parseAiResponse('```json\n{"outcome":"online"}\n```');
    expect(d.kind).toBe('no_travel_confirmed');
  });

  it('malformed JSON → error (never no-travel)', () => {
    expect(parseAiResponse('not json at all').kind).toBe('error');
    expect(parseAiResponse('{"outcome":"maybe"}').kind).toBe('error');
  });
});

describe('createAddressFormatter', () => {
  const ok: Completion = () => Promise.resolve('{"outcome":"travel_required","formatted":"X 1"}');

  it('empty location → unresolved (unknown travel, not zero)', async () => {
    const f = createAddressFormatter(ok);
    expect((await f.format('')).kind).toBe('unresolved_location');
    expect((await f.format(null)).kind).toBe('unresolved_location');
  });

  it('a transport failure → error (→ retry → FOUT), never no-travel', async () => {
    const boom: Completion = () => Promise.reject(new Error('timeout'));
    const f = createAddressFormatter(boom);
    const d = await f.format('Somewhere');
    expect(d.kind).toBe('error');
  });

  it('passes model output through parseAiResponse', async () => {
    const f = createAddressFormatter(ok);
    expect(await f.format('X 1')).toEqual({
      kind: 'travel_required',
      formatted: 'X 1',
      city: null,
      precision: 'exact',
    });
  });
});
