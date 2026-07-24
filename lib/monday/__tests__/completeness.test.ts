import { describe, expect, it } from 'vitest';

import {
  assertApiVersion,
  assertCoherent,
  assertCountMatches,
  assertNoDuplicateIds,
  diffInventory,
  findDuplicateIds,
  type Inventory,
} from '../completeness';

describe('assertApiVersion', () => {
  it('passes when the reported version equals the requested one', () => {
    expect(() => assertApiVersion('2026-07', '2026-07')).not.toThrow();
  });

  it('throws on a silent fallback to a different version', () => {
    expect(() => assertApiVersion('2026-04', '2026-07')).toThrow(/API-Version mismatch/);
  });

  it('throws when the server reports no version', () => {
    expect(() => assertApiVersion(null, '2026-07')).toThrow(/reported none/);
  });
});

describe('findDuplicateIds / assertNoDuplicateIds', () => {
  it('finds ids seen more than once', () => {
    expect(findDuplicateIds(['a', 'b', 'a', 'c', 'c'])).toEqual(['a', 'c']);
  });

  it('returns [] when all ids are unique', () => {
    expect(findDuplicateIds(['a', 'b', 'c'])).toEqual([]);
  });

  it('throws with the offending ids', () => {
    expect(() => assertNoDuplicateIds(['a', 'a'], 'agenda')).toThrow(/duplicate item ids/);
  });
});

describe('assertCountMatches', () => {
  it('passes when fetched equals items_count', () => {
    expect(() => assertCountMatches(754, 754, 'agenda')).not.toThrow();
  });

  it('throws on a mismatch', () => {
    expect(() => assertCountMatches(753, 754, 'agenda')).toThrow(/fetched 753.*items_count is 754/);
  });

  it('treats a null items_count as unverifiable (fatal)', () => {
    expect(() => assertCountMatches(10, null, 'agenda')).toThrow(/cannot prove completeness/);
  });
});

describe('diffInventory / assertCoherent', () => {
  const before: Inventory = new Map([
    ['1', '2026-07-01T00:00:00Z'],
    ['2', '2026-07-01T00:00:00Z'],
  ]);

  it('reports no diff for an identical inventory', () => {
    expect(diffInventory(before, new Map(before))).toEqual({ added: [], removed: [], changed: [] });
    expect(() => assertCoherent(before, new Map(before), 'agenda')).not.toThrow();
  });

  it('detects an added id', () => {
    const after: Inventory = new Map([...before, ['3', '2026-07-02T00:00:00Z']]);
    expect(diffInventory(before, after).added).toEqual(['3']);
    expect(() => assertCoherent(before, after, 'agenda')).toThrow(/changed during pagination/);
  });

  it('detects a removed id', () => {
    const after: Inventory = new Map([['1', '2026-07-01T00:00:00Z']]);
    expect(diffInventory(before, after).removed).toEqual(['2']);
    expect(() => assertCoherent(before, after, 'agenda')).toThrow();
  });

  it('detects an advanced updated_at', () => {
    const after: Inventory = new Map([
      ['1', '2026-07-05T12:00:00Z'],
      ['2', '2026-07-01T00:00:00Z'],
    ]);
    expect(diffInventory(before, after).changed).toEqual(['1']);
    expect(() => assertCoherent(before, after, 'agenda')).toThrow();
  });
});
