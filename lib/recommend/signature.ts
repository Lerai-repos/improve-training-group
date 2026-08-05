import { timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication: a shared secret in the URL (`?token=`), compared in
 * constant time against `MONDAY_WEBHOOK_TOKEN`.
 *
 * This is THE scheme, and the JWT verifier that used to sit beside it is gone.
 * Keeping both was the real hazard: the docstring here already called the token
 * "the chosen webhook auth" while the runbook advertised a signing secret that had
 * never been checked against a real payload, so which gate actually protected the
 * endpoint depended on which line you read. Monday only signs webhooks created
 * through an integration app, and ITG has not set one up.
 *
 * A practical consequence in its favour: the token rides on the URL, so it is
 * present on the setup CHALLENGE too — unlike a JWT, which Monday omits there.
 * That lets the route authenticate before echoing anything.
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
