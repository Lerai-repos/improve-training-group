import { describe, expect, it } from 'vitest';

import { describeError } from '../error-text';

/** Zoals undici een weggevallen verbinding aanlevert: een nietszeggende buitenkant. */
function fetchFailed(cause: unknown): Error {
  return new Error('fetch failed', { cause });
}

describe('describeError', () => {
  it('haalt de echte reden onder "fetch failed" vandaan', () => {
    const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeError(fetchFailed(socket))).toBe('fetch failed ← read ECONNRESET (ECONNRESET)');
  });

  it('volgt de keten meerdere lagen diep', () => {
    const diep = fetchFailed(new Error('laag 2', { cause: new Error('laag 3') }));
    expect(describeError(diep)).toBe('fetch failed ← laag 2 ← laag 3');
  });

  it('kapt een keten af die naar zichzelf wijst', () => {
    const lus: Error & { cause?: unknown } = new Error('rondje');
    lus.cause = lus;
    // Zonder grens zou dit blijven hangen; met grens komt de tekst één keer terug.
    expect(describeError(lus)).toBe('rondje');
  });

  it('laat een gewone fout ongemoeid', () => {
    expect(describeError(new Error('Mail 403 bij verzenden'))).toBe('Mail 403 bij verzenden');
  });

  it('kan overweg met iets dat geen Error is', () => {
    expect(describeError('kapot')).toBe('kapot');
    expect(describeError(null)).toBe('onbekende fout');
  });
});
