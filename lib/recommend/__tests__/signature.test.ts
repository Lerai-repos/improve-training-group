import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { authorizeCron } from '../cron';
import { verifyMondaySignature, verifyWebhookToken } from '../signature';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function signJwt(secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ boardId: 1, exp: 9999999999 }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('verifyMondaySignature', () => {
  const SECRET = 'super-secret';

  it('accepts a token signed with the secret (with and without Bearer)', () => {
    const token = signJwt(SECRET);
    expect(verifyMondaySignature(token, SECRET)).toBe(true);
    expect(verifyMondaySignature(`Bearer ${token}`, SECRET)).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifyMondaySignature(signJwt('wrong'), SECRET)).toBe(false);
  });

  it('rejects a malformed or missing token', () => {
    expect(verifyMondaySignature('not.a.jwt.extra', SECRET)).toBe(false);
    expect(verifyMondaySignature('onlyonepart', SECRET)).toBe(false);
    expect(verifyMondaySignature(null, SECRET)).toBe(false);
    expect(verifyMondaySignature(signJwt(SECRET), '')).toBe(false);
  });

  it('rejects alg:none (confused-deputy) even with a matching secret', () => {
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ exp: 9999999999 }));
    // An empty signature with alg:none must not be accepted.
    expect(verifyMondaySignature(`${header}.${payload}.`, SECRET)).toBe(false);
  });

  it('rejects an expired token even when correctly signed', () => {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ exp: 1 })); // 1970
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(verifyMondaySignature(`${header}.${payload}.${sig}`, SECRET)).toBe(false);
  });
});

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

describe('authorizeCron', () => {
  it('accepts only the exact Bearer secret', () => {
    expect(authorizeCron('Bearer s3cret', 's3cret')).toBe(true);
    expect(authorizeCron('Bearer wrong', 's3cret')).toBe(false);
    expect(authorizeCron(null, 's3cret')).toBe(false);
    expect(authorizeCron('Bearer s3cret', undefined)).toBe(false);
    expect(authorizeCron('Bearer ', '')).toBe(false);
  });
});
