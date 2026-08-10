import { describe, expect, it } from 'vitest';

import { createMondayBridge } from '../monday-client';

/**
 * Only the pure translation is testable here — a real iframe cannot be driven in jsdom,
 * and `createMondayBridge` deliberately does not initialise the SDK until first use, so
 * constructing it is safe.
 */
describe('createMondayBridge', () => {
  it('constructs without touching the SDK', () => {
    expect(() => createMondayBridge()).not.toThrow();
  });
});
