import { describe, expect, it } from 'vitest';

import { createAddressFormatter, parseAiResponse, type Completion } from '../address';

describe('parseAiResponse', () => {
  it('travel_required with a formatted address', () => {
    const d = parseAiResponse(
      '{"outcome":"travel_required","formatted":"Wolvenplein 25, Utrecht"}'
    );
    expect(d).toEqual({ kind: 'travel_required', formatted: 'Wolvenplein 25, Utrecht' });
  });

  it('online → the only zero-travel path', () => {
    expect(parseAiResponse('{"outcome":"online","formatted":null}')).toEqual({
      kind: 'no_travel_confirmed',
      reason: 'online',
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
    expect(await f.format('X 1')).toEqual({ kind: 'travel_required', formatted: 'X 1' });
  });
});
