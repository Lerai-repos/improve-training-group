/**
 * Constant-shape bearer check for the self-authenticating `/api` routes (the
 * middleware that used to guard them is gone, and `/api` was excluded from it
 * anyway). An unset or empty secret NEVER authorizes — a missing env var must not
 * silently open an endpoint.
 */
export function authorizeBearer(authHeader: string | null, secret: string | undefined): boolean {
  return typeof secret === 'string' && secret.length > 0 && authHeader === `Bearer ${secret}`;
}
