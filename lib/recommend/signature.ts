import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const jwtHeaderSchema = z.object({ alg: z.string() });
const jwtPayloadSchema = z.object({ exp: z.number().optional() });

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Verify a Monday webhook JWT (HS256) against the app signing secret. The `/api`
 * route is outside `middleware.ts` auth, so this is the only gate — an unverified
 * or tampered token is rejected. (The exact Monday signing scheme is confirmed in
 * Phase-6 payload capture; HS256 over `header.payload` is the documented default.)
 */
/**
 * Verify the URL shared-secret (`?token=`) — the chosen webhook auth. Constant-time
 * compare against `MONDAY_WEBHOOK_TOKEN`. Simpler than a signed Monday app and needs
 * no app setup; the endpoint only enqueues an idempotent, generation-guarded job.
 */
export function verifyWebhookToken(requestUrl: string, secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }
  let token: string | null;
  try {
    token = new URL(requestUrl).searchParams.get('token');
  } catch {
    return false;
  }
  if (!token) {
    return false;
  }
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyMondaySignature(authHeader: string | null, secret: string): boolean {
  if (!authHeader || secret === '') {
    return false;
  }
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader.trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [header, payload, signature] = parts;

  // Algorithm must be HS256 — reject alg:none and any confused-deputy alg swap.
  const headerParsed = jwtHeaderSchema.safeParse(decodeSegment(header));
  if (!headerParsed.success || headerParsed.data.alg !== 'HS256') {
    return false;
  }

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    return false;
  }

  // Reject an expired token when it carries an exp claim.
  const payloadParsed = jwtPayloadSchema.safeParse(decodeSegment(payload));
  if (payloadParsed.success && payloadParsed.data.exp !== undefined) {
    if (payloadParsed.data.exp * 1000 < Date.now()) {
      return false;
    }
  }
  return true;
}
