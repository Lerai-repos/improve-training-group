import { describe, expect, it } from 'vitest';

import {
  FIELD_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  formatWhatsappMessage,
  type TrainingDetails,
} from '../whatsapp';

/**
 * The rules come from the n8n node this replaces (`Prepare Training Data`,
 * `flows/flow-6-live-training-sync.md:554-582`), cross-checked against the 455 real
 * messages in `snapshots/airtable/trainingen.json`. Where this deviates it is on purpose
 * and the test says so.
 */

function details(overrides: Partial<TrainingDetails> = {}): TrainingDetails {
  return {
    datum: '2026-03-23',
    thema: 'Effectief time management',
    tijden: '09.00-13.00',
    taal: 'ENG',
    locatie: 'Amsterdam',
    deelnemers: '9',
    trainers: 2,
    acteurs: 1,
    klant: 'Rabobank',
    ...overrides,
  };
}

const lines = (d: TrainingDetails): string[] => formatWhatsappMessage(d).text.split('\n');

describe('formatWhatsappMessage', () => {
  /** The spec's own example (`docs/build/03-aanbevelingsengine.md:236`), byte for byte. */
  it('reproduces the documented message exactly', () => {
    expect(formatWhatsappMessage(details()).text).toBe(
      [
        'Ben jij beschikbaar?',
        '',
        '23-03-2026',
        'Effectief time management',
        '09.00-13.00 uur',
        'Engels',
        'Amsterdam',
        '9 deelnemers',
        '2 trainers',
        '+1 acteur',
        'Rabobank',
      ].join('\n')
    );
  });

  describe('de datum', () => {
    it('reformats the ISO date to DD-MM-JJJJ', () => {
      expect(lines(details({ datum: '2026-11-10' }))[2]).toBe('10-11-2026');
    });

    /**
     * Legacy does `new Date(iso).getDate()`, which reads an ISO date as UTC midnight and
     * then formats it in local time — a day earlier anywhere west of UTC. Splitting the
     * string has no timezone to get wrong.
     */
    it('does not shift the day', () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = 'America/Los_Angeles';
        expect(lines(details({ datum: '2026-01-01' }))[2]).toBe('01-01-2026');
      } finally {
        process.env.TZ = original;
      }
    });

    it('drops the line for a date that is not a calendar date', () => {
      expect(formatWhatsappMessage(details({ datum: 'binnenkort' })).text).not.toContain(
        'binnenkort'
      );
    });
  });

  describe('de tijden', () => {
    it('appends "uur"', () => {
      expect(lines(details({ tijden: '12:00 - 16:00' }))[4]).toBe('12:00 - 16:00 uur');
    });

    /** The corpus has "14.30-15.30 uur uur" from the pre-February formula. Not us. */
    it('does not append it twice', () => {
      expect(lines(details({ tijden: '14.30-15.30 uur' }))[4]).toBe('14.30-15.30 uur');
    });

    it('ignores the case of an existing "Uur"', () => {
      expect(lines(details({ tijden: '09.00-17.00 Uur' }))[4]).toBe('09.00-17.00 Uur');
    });
  });

  describe('de taal', () => {
    it.each([
      ['NL', 'Nederlands'],
      ['ENG', 'Engels'],
      ['NL + ENG', 'Nederlands + Engels'],
    ])('writes %s out as %s', (code, written) => {
      expect(lines(details({ taal: code }))[5]).toBe(written);
    });

    /** An unmapped value is the planner's own text and is passed through, not dropped. */
    it('passes an unknown language through unchanged', () => {
      expect(lines(details({ taal: 'Duits' }))[5]).toBe('Duits');
    });
  });

  describe('de deelnemers', () => {
    it('appends "deelnemers"', () => {
      expect(lines(details({ deelnemers: '12' }))[7]).toBe('12 deelnemers');
    });

    /** `Deeln.` is a TEXT column: "max 15" is a real live value, not a number. */
    it('keeps a non-numeric count and still appends', () => {
      expect(lines(details({ deelnemers: 'max 15' }))[7]).toBe('max 15 deelnemers');
    });

    it('does not append when the word is already there', () => {
      expect(lines(details({ deelnemers: '10-15 per sessie deelnemers' }))[7]).toBe(
        '10-15 per sessie deelnemers'
      );
    });
  });

  describe('trainers en acteurs', () => {
    it('shows the trainer count only from two', () => {
      expect(formatWhatsappMessage(details({ trainers: 2 })).text).toContain('2 trainers');
      expect(formatWhatsappMessage(details({ trainers: 1 })).text).not.toContain('trainer');
      expect(formatWhatsappMessage(details({ trainers: 0 })).text).not.toContain('trainer');
      expect(formatWhatsappMessage(details({ trainers: null })).text).not.toContain('trainer');
    });

    it('shows the actor count from one', () => {
      expect(formatWhatsappMessage(details({ acteurs: 1 })).text).toContain('+1 acteur');
      expect(formatWhatsappMessage(details({ acteurs: 0 })).text).not.toContain('acteur');
      expect(formatWhatsappMessage(details({ acteurs: null })).text).not.toContain('acteur');
    });

    /**
     * Legacy writes "+2 acteur", never "acteurs". Kept deliberately: this is a fidelity
     * copy of a message ITG has been sending for months, and pluralising it is a content
     * change for Dirkje to approve, not a typo for us to fix.
     */
    it('never pluralises the actor noun', () => {
      expect(formatWhatsappMessage(details({ acteurs: 3 })).text).toContain('+3 acteur');
    });
  });

  describe('lege velden', () => {
    /**
     * Legacy emits the newline anyway, so a training without Tijden gets a blank line in
     * the middle of the message. That is a defect, not a format.
     */
    it('drops the line instead of leaving a blank one', () => {
      const message = formatWhatsappMessage(details({ tijden: null, taal: '   ' }));

      // The blank line after the header is the format; a blank line in the body is the bug.
      expect(message.text.split('\n').slice(2)).not.toContain('');
      expect(message.text.split('\n')[1]).toBe('');
    });

    it('names what was left out, so the planner can fill it in', () => {
      expect(formatWhatsappMessage(details({ tijden: null })).omitted).toContain('tijden');
    });

    it('still produces the header and the fields it does have', () => {
      const message = formatWhatsappMessage({
        datum: null,
        thema: null,
        tijden: null,
        taal: null,
        locatie: null,
        deelnemers: null,
        trainers: null,
        acteurs: null,
        klant: 'Rabobank',
      });

      expect(message.text).toBe('Ben jij beschikbaar?\n\nRabobank');
    });
  });

  describe('grenzen', () => {
    /**
     * Monday text columns have no length limit, and the record that stores this message
     * does. Without a cap here a pathological Locatie produces a message that renders
     * fine and can never be saved.
     */
    it('truncates an over-long field and says so', () => {
      const message = formatWhatsappMessage(details({ locatie: 'x'.repeat(500) }));

      expect(message.text).toContain('x'.repeat(FIELD_MAX_LENGTH));
      expect(message.text).not.toContain('x'.repeat(FIELD_MAX_LENGTH + 1));
      expect(message.warnings.join(' ')).toMatch(/locatie/i);
    });

    it('leaves a field at exactly the limit alone', () => {
      const message = formatWhatsappMessage(details({ locatie: 'x'.repeat(FIELD_MAX_LENGTH) }));
      expect(message.warnings).toEqual([]);
    });

    it('holds the whole message under its own limit whatever the input', () => {
      const long = 'x'.repeat(FIELD_MAX_LENGTH * 4);
      const message = formatWhatsappMessage({
        datum: '2026-03-23',
        thema: long,
        tijden: long,
        taal: long,
        locatie: long,
        deelnemers: long,
        trainers: 999,
        acteurs: 999,
        klant: long,
      });

      expect(message.text.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH);
    });
  });
});

describe('what counts as "not filled in"', () => {
  /**
   * One trainer and no actors is the ordinary case, and the message deliberately says
   * nothing about either. Reporting them as missing told every normal training that a
   * populated, correctly-read column had been left blank.
   */
  it('does not report a single trainer as missing', () => {
    expect(formatWhatsappMessage(details({ trainers: 1 })).omitted).not.toContain('trainers');
  });

  it('does not report zero actors as missing', () => {
    expect(formatWhatsappMessage(details({ acteurs: 0 })).omitted).not.toContain('acteurs');
  });

  it('does not report an empty trainer or actor column as missing either', () => {
    const message = formatWhatsappMessage(details({ trainers: null, acteurs: null }));

    expect(message.omitted).not.toContain('trainers');
    expect(message.omitted).not.toContain('acteurs');
  });

  /**
   * `rendered` and `omitted` answer different questions, and the conditional lines are
   * in neither. Deriving one from the other is what made a drifted trainer column look
   * as though a fallback had covered it.
   */
  it('reports what rendered separately from what is missing', () => {
    const message = formatWhatsappMessage(details({ trainers: 1, tijden: null }));

    expect(message.rendered).toContain('datum');
    expect(message.rendered).not.toContain('trainers');
    expect(message.rendered).not.toContain('tijden');

    expect(message.omitted).toContain('tijden');
    expect(message.omitted).not.toContain('trainers');
  });

  it('lists a conditional line in rendered once it does appear', () => {
    expect(formatWhatsappMessage(details({ trainers: 3 })).rendered).toContain('trainers');
  });

  /** The always-shown lines are still reported, which is the point of the list. */
  it('still reports a field the planner really has left blank', () => {
    const message = formatWhatsappMessage(details({ tijden: null, deelnemers: null }));

    expect(message.omitted).toContain('tijden');
    expect(message.omitted).toContain('deelnemers');
  });
});
