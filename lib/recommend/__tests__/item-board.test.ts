import { describe, expect, it } from 'vitest';

import { createItemBoardReader, parseItemBoard } from '../item-board';

const ITEM = '5029726254';
const BOARD = '5087396949';

describe('parseItemBoard', () => {
  it('reads the board id', () => {
    expect(parseItemBoard({ items: [{ id: ITEM, board: { id: BOARD } }] }, ITEM)).toBe(BOARD);
  });

  /**
   * Monday echoes ids as strings or numbers depending on the field, so the comparison
   * normalizes rather than trusting the type it happens to get.
   */
  it('accepts numeric ids', () => {
    expect(parseItemBoard({ items: [{ id: 5029726254, board: { id: 5087396949 } }] }, ITEM)).toBe(
      BOARD
    );
  });

  /** A missing id comes back as an empty list, not as an error. */
  it('returns null when the item does not exist', () => {
    expect(parseItemBoard({ items: [] }, ITEM)).toBeNull();
    expect(parseItemBoard({ items: null }, ITEM)).toBeNull();
  });

  /**
   * Matching on the echoed id rather than on position: a query answered with a
   * different item — or with several — must not silently authorize this one.
   */
  it('does not accept another item’s board', () => {
    expect(parseItemBoard({ items: [{ id: '999', board: { id: BOARD } }] }, ITEM)).toBeNull();
    expect(
      parseItemBoard(
        {
          items: [
            { id: '999', board: { id: '111' } },
            { id: ITEM, board: { id: BOARD } },
          ],
        },
        ITEM
      )
    ).toBe(BOARD);
  });

  it('returns null for an item with no board, or an unrecognizable reply', () => {
    expect(parseItemBoard({ items: [{ id: ITEM, board: null }] }, ITEM)).toBeNull();
    for (const raw of [null, {}, 'nope', { items: [{ id: ITEM }] }]) {
      expect(parseItemBoard(raw, ITEM)).toBeNull();
    }
  });
});

describe('createItemBoardReader', () => {
  it('asks for one id and nothing else', async () => {
    const calls: Array<{ document: string; variables?: Record<string, unknown> }> = [];
    const reader = createItemBoardReader({
      query: <T,>(document: string, variables?: Record<string, unknown>) => {
        calls.push({ document, variables });
        return Promise.resolve<T>(
          JSON.parse(JSON.stringify({ items: [{ id: ITEM, board: { id: BOARD } }] }))
        );
      },
    });

    expect(await reader.readBoardId(ITEM)).toBe(BOARD);
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ ids: [ITEM] });
    // No column_values: this runs on every mutation, including refused ones, and should
    // cost an id lookup rather than a full read.
    expect(calls[0].document).not.toContain('column_values');
  });
});
