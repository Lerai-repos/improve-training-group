/**
 * Database target resolution + non-prod guard for privileged scripts.
 *
 * The admin client resolves `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL` (see
 * `createAdminSupabaseClient`). A `--apply` guard MUST check that exact URL — a
 * local public URL with a production `SUPABASE_URL` would otherwise write to
 * prod. Hostname is parsed strictly (not a substring match).
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The URL the admin client will actually connect to. */
export function resolveAdminDbUrl(): string {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error('Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL');
  }
  return url;
}

export function isLocalDbUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Throw unless `url` is a local database (strict hostname check). */
export function assertNonProdTarget(url: string): void {
  if (!isLocalDbUrl(url)) {
    throw new Error(`refusing --apply against a non-local database target: ${url}`);
  }
}
