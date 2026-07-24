import { describe, expect, it } from 'vitest';

import type { BoardMeta } from '../graphql-client';
import { assertColumns, checkSourceDrop } from '../schema-check';

const board = (columns: Array<{ id: string; type: string }>): BoardMeta => ({
  id: 'b1',
  name: 'Board',
  groups: [],
  columns: columns.map((c) => ({ ...c, title: c.id, settings_str: null })),
  items_count: 10,
});

describe('assertColumns (schema drift)', () => {
  const expected = [{ id: 'rel', type: 'board_relation' }];

  it('passes when the column exists with the expected type', () => {
    expect(() =>
      assertColumns(board([{ id: 'rel', type: 'board_relation' }]), expected)
    ).not.toThrow();
  });

  it('throws when a configured column is missing', () => {
    expect(() => assertColumns(board([]), expected)).toThrow(/missing column rel/);
  });

  it('throws when a column was retyped (would silently empty its links)', () => {
    expect(() => assertColumns(board([{ id: 'rel', type: 'text' }]), expected)).toThrow(
      /is type 'text'/
    );
  });

  it('throws on a same-type relation repointed to a different board (settings signature)', () => {
    const withSettings: BoardMeta = {
      id: 'b1',
      name: 'Board',
      groups: [],
      items_count: 10,
      columns: [
        { id: 'rel', title: 'rel', type: 'board_relation', settings_str: '{"boardIds":[999]}' },
      ],
    };
    const exp = [
      { id: 'rel', type: 'board_relation', settingsIncludes: ['"boardIds":[1661151090]'] },
    ];
    expect(() => assertColumns(withSettings, exp)).toThrow(/repointed|re-sourced/);
  });
});

describe('checkSourceDrop', () => {
  it('returns null when there is no previous run', () => {
    expect(checkSourceDrop({ agenda: 700 }, null, {})).toBeNull();
  });

  it('returns null when totals are stable', () => {
    expect(checkSourceDrop({ agenda: 700 }, { agenda: 720 }, {})).toBeNull();
  });

  it('is fatal on a substantial drop with no approval', () => {
    const a = checkSourceDrop({ agenda: 5 }, { agenda: 720 }, {});
    expect(a?.severity).toBe('fatal');
    expect(a?.kind).toBe('source_drop');
  });

  it('allows ONLY when the approved {from,to} transition matches exactly', () => {
    expect(
      checkSourceDrop({ agenda: 5 }, { agenda: 720 }, { agenda: { from: 720, to: 5 } })?.severity
    ).toBe('allowed');
    // Same target but a DIFFERENT baseline (board recovered then fell again) → fatal.
    expect(
      checkSourceDrop({ agenda: 5 }, { agenda: 900 }, { agenda: { from: 720, to: 5 } })?.severity
    ).toBe('fatal');
    // Different current → fatal.
    expect(
      checkSourceDrop({ agenda: 3 }, { agenda: 720 }, { agenda: { from: 720, to: 5 } })?.severity
    ).toBe('fatal');
  });

  it('catches a section-count collapse (e.g. all qualifications cleared)', () => {
    expect(
      checkSourceDrop({ qual_observations: 0 }, { qual_observations: 3555 }, {})?.severity
    ).toBe('fatal');
  });
});
