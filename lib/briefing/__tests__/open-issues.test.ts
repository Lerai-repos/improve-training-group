import { describe, expect, it } from 'vitest';

import { describeOpenIssue, isNotDecided, notConnected, notDecided } from '../open-issues';

/**
 * Het verschil tussen de twee soorten openstaande regels bepaalt of een briefing compleet is.
 * `nog niet bepaald` kan de adviseur oplossen; `nog niet aangesloten` is ónze achterstand.
 */
describe('isNotDecided', () => {
  it('herkent wat de adviseur kan oplossen', () => {
    expect(isNotDecided(notDecided('evaluatie deelnemers', 'de QR-kolom staat op "0. NOTK"'))).toBe(
      true
    );
  });

  it('telt een bron die Lerai nog niet heeft gebouwd niet mee', () => {
    expect(isNotDecided(notConnected('inventarisatie klant', 'Google Form van het label'))).toBe(
      false
    );
  });

  it('ziet gewone tekst niet als openstaand', () => {
    expect(isNotDecided('Plenaire opening.')).toBe(false);
  });
});

describe('describeOpenIssue', () => {
  it('maakt van de documentregel een zin voor het scherm', () => {
    expect(describeOpenIssue(notDecided('evaluatie deelnemers', 'de QR-kolom staat op "X"'))).toBe(
      'Evaluatie deelnemers: de QR-kolom staat op "X"'
    );
  });

  it('laat een streepje in de reden zelf staan', () => {
    expect(describeOpenIssue(notDecided('thema', 'a — b'))).toBe('Thema: a — b');
  });
});
