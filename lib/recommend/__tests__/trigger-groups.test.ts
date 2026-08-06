import { afterEach, describe, expect, it } from 'vitest';

import {
  HERPLANNEN_GROUP_ID,
  INPLANNEN_GROUP_ID,
  triggerGroupIds,
} from '@lib/monday/board-config';

/**
 * The groups a move must land in to trigger a run.
 *
 * The failure mode these guard against is silent: a group id that matches nothing
 * makes every group-move webhook return a perfectly healthy 200 while no run is ever
 * queued. Nothing errors, nothing is logged above debug, and the board simply stays
 * blank — which is exactly how a misconfigured group presented in practice.
 */

const ENV = 'MONDAY_TRIGGER_GROUP_IDS';
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = original;
  }
});

describe('triggerGroupIds', () => {
  it('defaults to both Inplannen and Herplannen / Inplannen', () => {
    delete process.env[ENV];
    expect(triggerGroupIds()).toEqual([INPLANNEN_GROUP_ID, HERPLANNEN_GROUP_ID]);
  });

  it('takes a comma-separated override', () => {
    process.env[ENV] = 'group_a,group_b,group_c';
    expect(triggerGroupIds()).toEqual(['group_a', 'group_b', 'group_c']);
  });

  it('trims whitespace around each id', () => {
    process.env[ENV] = ' group_a , group_b ';
    expect(triggerGroupIds()).toEqual(['group_a', 'group_b']);
  });

  it('drops a trailing comma rather than yielding an empty id', () => {
    // An empty string would match no group, so the webhook would 200 and drop the
    // trigger — worse than falling back, because it looks healthy.
    process.env[ENV] = 'group_a,';
    expect(triggerGroupIds()).toEqual(['group_a']);
  });

  it('falls back when the override is blank', () => {
    process.env[ENV] = '';
    expect(triggerGroupIds()).toEqual([INPLANNEN_GROUP_ID, HERPLANNEN_GROUP_ID]);
  });

  it('falls back when the override is only separators and whitespace', () => {
    process.env[ENV] = ' , , ';
    expect(triggerGroupIds()).toEqual([INPLANNEN_GROUP_ID, HERPLANNEN_GROUP_ID]);
  });

  it('never returns an empty list', () => {
    for (const value of ['', ' ', ',', ',,', ' , ']) {
      process.env[ENV] = value;
      expect(triggerGroupIds().length).toBeGreaterThan(0);
    }
  });
});
