import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatWhatsappMessage, type TrainingDetails } from '../whatsapp';

/**
 * The golden corpus: every WhatsApp message n8n actually produced, still sitting in the
 * Airtable snapshot.
 *
 * This is the test that says our rules are ITG's rules. Unit tests prove the rules do
 * what we wrote down; only real output proves we wrote down the right ones.
 *
 * **Why exact counts rather than a threshold.** Agreement is not 100% and cannot be: the
 * corpus contains hand-edited messages ("2 sessies, zelfde groep" typed over the times),
 * messages generated before the training was rescheduled, and 16 records carrying
 * "14.30-15.30 uur uur" from the pre-February formula that appended the word blindly. Our
 * rule is right and those records are wrong. A `>= 90%` assertion would pass while a real
 * regression ate the difference; a pinned number turns any change in the rules into a
 * failing diff that has to be explained.
 *
 * **What the corpus cannot check.** `thema` and `locatie` are excluded — Airtable stores
 * the theme *link*, not Monday's free-text `tekst` column, and its `Locatie` field is
 * inconsistently the city or the full address. `trainers` and `acteurs` were never synced
 * to Airtable at all. Those four are covered by `whatsapp.test.ts` against the n8n source.
 */

interface AirtableRecord {
  fields: Record<string, unknown>;
}

const CORPUS = new URL('../../../snapshots/airtable/trainingen.json', import.meta.url);

/**
 * The message format changed on 18-Feb-2026 from a 5-line formula to the current one.
 * Only the current format is evidence of the current rules; the 1.989 older records are a
 * different message entirely.
 */
const CURRENT_FORMAT_MIN_LINES = 8;

/** Legacy always emits these six lines, blank or not, so their positions are fixed. */
const LINE_INDEX = { datum: 2, tijden: 4, taal: 5, deelnemers: 7 } as const;

type Comparable = keyof typeof LINE_INDEX | 'klant';

const EMPTY: TrainingDetails = {
  datum: null,
  thema: null,
  tijden: null,
  taal: null,
  locatie: null,
  deelnemers: null,
  trainers: null,
  acteurs: null,
  klant: null,
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** What our formatter would render for one field alone. */
function ourLine(field: Comparable, value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const [line] = formatWhatsappMessage({ ...EMPTY, [field]: value })
    .text.split('\n')
    .slice(2);
  return line ?? null;
}

function sourceOf(fields: Record<string, unknown>, field: Comparable): string | null {
  switch (field) {
    case 'datum':
      return str(fields['Datum']);
    case 'tijden':
      return str(fields['Tijd']);
    case 'taal':
      return str(fields['Taal']);
    case 'deelnemers':
      return str(fields['Aantal deelnemers']);
    case 'klant': {
      const names = fields['Bedrijfsnaam'];
      return Array.isArray(names) ? str(names[0]) : null;
    }
  }
}

describe('parity with the messages n8n actually sent', () => {
  const all: AirtableRecord[] = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const corpus = all.filter((record) => {
    const message = record.fields['Whatsapp Bericht'];
    return typeof message === 'string' && message.split('\n').length >= CURRENT_FORMAT_MIN_LINES;
  });

  const agreement = (field: Comparable): { matched: number; compared: number } => {
    let matched = 0;
    let compared = 0;
    for (const { fields } of corpus) {
      const ours = ourLine(field, sourceOf(fields, field));
      if (ours === null) {
        continue;
      }
      compared += 1;
      const expected = String(fields['Whatsapp Bericht']).split('\n');
      // Klant is last, after any optional trainers/actors lines and anything the planner
      // appended, so it is matched anywhere rather than at a fixed index.
      const hit =
        field === 'klant' ? expected.includes(ours) : expected[LINE_INDEX[field]] === ours;
      if (hit) {
        matched += 1;
      }
    }
    return { matched, compared };
  };

  it('has the corpus it thinks it has', () => {
    expect(all.length).toBe(2555);
    expect(corpus.length).toBe(455);
  });

  /** 52 records were rescheduled or hand-edited after the message was generated. */
  it('reproduces the datum line', () => {
    expect(agreement('datum')).toEqual({ matched: 403, compared: 455 });
  });

  /** 16 doubled "uur" from the old formula; the rest are hand-written replacements. */
  it('reproduces the tijden line', () => {
    expect(agreement('tijden')).toEqual({ matched: 372, compared: 437 });
  });

  it('reproduces the taal line', () => {
    expect(agreement('taal')).toEqual({ matched: 416, compared: 454 });
  });

  it('reproduces the deelnemers line', () => {
    expect(agreement('deelnemers')).toEqual({ matched: 406, compared: 455 });
  });

  it('reproduces the klant line', () => {
    expect(agreement('klant')).toEqual({ matched: 454, compared: 455 });
  });
});
