import { describe, expect, it } from 'vitest';

import { authorizeBearer } from '../authorize';
import { verifyWebhookToken } from '../signature';

describe('verifyWebhookToken', () => {
  const base = 'https://x.dev/api/webhooks/monday/recommendations';
  it('accepts the exact ?token and rejects everything else', () => {
    expect(verifyWebhookToken(`${base}?token=abc123`, 'abc123')).toBe(true);
    expect(verifyWebhookToken(`${base}?token=wrong`, 'abc123')).toBe(false);
    expect(verifyWebhookToken(base, 'abc123')).toBe(false);
    expect(verifyWebhookToken(`${base}?token=abc123`, undefined)).toBe(false);
    expect(verifyWebhookToken('not a url', 'abc123')).toBe(false);
  });
});

describe('authorizeBearer', () => {
  it('accepts only the exact Bearer secret', () => {
    expect(authorizeBearer('Bearer s3cret', 's3cret')).toBe(true);
    expect(authorizeBearer('Bearer wrong', 's3cret')).toBe(false);
    expect(authorizeBearer(null, 's3cret')).toBe(false);
    expect(authorizeBearer('Bearer s3cret', undefined)).toBe(false);
    expect(authorizeBearer('Bearer ', '')).toBe(false);
  });
});
