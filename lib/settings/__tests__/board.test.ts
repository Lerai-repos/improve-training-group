import { describe, expect, it } from 'vitest';

import { resolveSettingsBoard, settingsBoardId } from '../board';

const PRODUCTION = '9999999999';
const PREVIEW = '1111111111';

const pinned = { boardId: PRODUCTION, notitiesGroupId: 'group_notities' };

describe('settingsBoardId', () => {
  it('uses the pinned constant in production', () => {
    expect(settingsBoardId(pinned, { VERCEL_ENV: 'production' })).toBe(PRODUCTION);
  });

  /**
   * One contract, no "accepted if it happens to be equal": a variable that should not
   * exist in production is a misconfiguration whatever its value, and refusing to boot
   * is a great deal cheaper to diagnose than pricing every training from a test board.
   */
  it('refuses to boot when the override is set in production at all', () => {
    expect(() =>
      settingsBoardId(pinned, { VERCEL_ENV: 'production', MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW })
    ).toThrow(/MONDAY_INSTELLINGEN_BOARD_ID/);

    // Even when it agrees — the ambiguity is the problem, not the disagreement.
    expect(() =>
      settingsBoardId(pinned, {
        VERCEL_ENV: 'production',
        MONDAY_INSTELLINGEN_BOARD_ID: PRODUCTION,
      })
    ).toThrow(/MONDAY_INSTELLINGEN_BOARD_ID/);
  });

  /**
   * `VERCEL_ENV`, not `NODE_ENV`. A built Vercel preview has `NODE_ENV=production`, so
   * gating on that would reject the very deployment the destructive checks require.
   */
  it('accepts the override on preview, where NODE_ENV is also production', () => {
    expect(
      settingsBoardId(pinned, {
        VERCEL_ENV: 'preview',
        NODE_ENV: 'production',
        MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW,
        MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID: 'group_preview_notities',
      })
    ).toBe(PREVIEW);
  });

  it('accepts the override locally', () => {
    expect(
      settingsBoardId(pinned, {
        MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW,
        MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID: 'group_preview_notities',
      })
    ).toBe(PREVIEW);
  });

  /**
   * Monday generates the Notities group id PER BOARD. Half an override would pair the
   * preview board with the production group, and every note on it would then read as a
   * broken setting — so the pair is refused rather than silently completed.
   */
  it('refuses a board override without its group override', () => {
    expect(() =>
      settingsBoardId(pinned, { MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW })
    ).toThrow(/NOTITIES_GROUP_ID/);
  });

  it('resolves board and group as one pair', () => {
    expect(
      resolveSettingsBoard(pinned, {
        MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW,
        MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID: 'group_preview_notities',
      })
    ).toEqual({ boardId: PREVIEW, notitiesGroupId: 'group_preview_notities' });
  });

  it('falls back to the pinned board off production when no override is given', () => {
    expect(settingsBoardId(pinned, { VERCEL_ENV: 'preview' })).toBe(PRODUCTION);
  });

  /**
   * Before `instellingen:create` has run there is no board to pin, and the constant is
   * empty. Reading settings then must fail loudly rather than query board "".
   */
  it('throws while the constant is still unpinned and nothing overrides it', () => {
    const unpinned = { boardId: '', notitiesGroupId: '' };

    expect(() => settingsBoardId(unpinned, { VERCEL_ENV: 'production' })).toThrow(/nog niet/i);
    expect(() => settingsBoardId(unpinned, {})).toThrow(/nog niet/i);
  });

  it('still allows a local override before the constant is pinned', () => {
    const unpinned = { boardId: '', notitiesGroupId: '' };

    expect(
      settingsBoardId(unpinned, {
        MONDAY_INSTELLINGEN_BOARD_ID: PREVIEW,
        MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID: 'group_preview_notities',
      })
    ).toBe(PREVIEW);
  });
});
