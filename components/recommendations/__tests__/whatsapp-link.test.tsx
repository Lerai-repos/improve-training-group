import { describe, expect, it } from 'vitest';

import { normalisePhone, personalise, whatsappHref } from '../whatsapp-link';

/**
 * Pinned against a real legacy link out of `snapshots/airtable/aanbevelingen.json`:
 *
 *   https://wa.me/31611771540?text=Hey%20Carlijn%2C%20ben%20jij%20beschikbaar%3F%0A%0A07-10-2026…
 *
 * from `Telefoonnummer Trainer: "0611771540"`. Reproducing that exactly is the point — the
 * planners have been sending this message for a year and it should not quietly change
 * shape because we rebuilt the button.
 */

describe('normalisePhone', () => {
  /** How ITG's board actually holds them — all three spellings occur. */
  it.each([
    ['0611771540', '31611771540'],
    ['+31611771540', '31611771540'],
    ['0031611771540', '31611771540'],
    ['31611771540', '31611771540'],
    ['+31 6 11 77 15 40', '31611771540'],
    ['06-11771540', '31611771540'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normalisePhone(raw)).toBe(expected);
  });

  /**
   * Null disables the button. Guessing would open a chat with whoever owns the number
   * those digits happen to form.
   */
  it.each([[null], [undefined], [''], ['   '], ['n.v.t.'], ['06-1234'], ['1'.repeat(20)]])(
    'refuses %s',
    (raw) => {
      expect(normalisePhone(raw)).toBeNull();
    }
  );
});

describe('personalise', () => {
  const generated = 'Ben jij beschikbaar?\n\n07-10-2026\nTimemanagement';

  /** Legacy folds the name into the opening line rather than adding one. */
  it('folds the first name into the generated opening line', () => {
    expect(personalise(generated, 'Carlijn de Groot')).toBe(
      'Hey Carlijn, ben jij beschikbaar?\n\n07-10-2026\nTimemanagement'
    );
  });

  /**
   * A planner who rewrote the opening gets the greeting on its own line: rewriting prose
   * somebody else typed is how a name ends up mid-sentence.
   */
  it('prepends a line when the message no longer opens with the header', () => {
    expect(personalise('Hoi! Interesse in 7 oktober?', 'Carlijn de Groot')).toBe(
      'Hey Carlijn,\n\nHoi! Interesse in 7 oktober?'
    );
  });

  /** The names lookup can fail; a greeting to nobody is worse than none. */
  it('leaves the message alone when the name is unknown', () => {
    expect(personalise(generated, null)).toBe(generated);
    expect(personalise(generated, '   ')).toBe(generated);
  });
});

describe('whatsappHref', () => {
  it('reproduces the legacy link', () => {
    const href = whatsappHref('0611771540', 'Ben jij beschikbaar?\n\n07-10-2026', 'Carlijn');

    expect(href).toBe(
      'https://wa.me/31611771540?text=Hey%20Carlijn%2C%20ben%20jij%20beschikbaar%3F%0A%0A07-10-2026'
    );
  });

  /** No number, no link — the column shows a disabled button and says why. */
  it('is null without a usable number', () => {
    expect(whatsappHref(null, 'Ben jij beschikbaar?', 'Carlijn')).toBeNull();
  });

  /** An empty draft would open WhatsApp with a blank box. */
  it('is null when the message is empty', () => {
    expect(whatsappHref('0611771540', '   ', 'Carlijn')).toBeNull();
  });
});
