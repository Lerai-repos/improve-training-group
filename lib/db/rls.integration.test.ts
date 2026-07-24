import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient, anonClient } from '@lib/testing/supabase-clients';

/**
 * RLS deny-all enforcement. With RLS on and no policies, the `anon` and
 * `authenticated` roles must see zero rows and be unable to mutate. Asserts
 * BEHAVIOR (no reads, blocked writes), not merely that RLS is toggled on.
 */
describe('RLS deny-all', () => {
  const admin = adminClient();
  const anon = anonClient();

  // An authenticated (logged-in user) client.
  const authed = anonClient();
  const email = `rls-${Date.now()}@example.com`;
  const password = 'password-123456';
  let userId: string | null = null;

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      throw error;
    }
    userId = data.user?.id ?? null;

    // Assert the sign-in actually succeeded — otherwise `authed` stays
    // unauthenticated and the "authenticated" tests would pass vacuously.
    const signIn = await authed.auth.signInWithPassword({ email, password });
    if (signIn.error) {
      throw signIn.error;
    }
    if (!signIn.data.session) {
      throw new Error('RLS test: authenticated sign-in returned no session');
    }
  });

  afterAll(async () => {
    if (userId) {
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it('admin (service role) CAN read seeded config', async () => {
    const { data, error } = await admin.from('config').select('*');
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('anon sees zero rows despite seeded data', async () => {
    const { data } = await anon.from('config').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('authenticated user also sees zero rows', async () => {
    const { data } = await authed.from('config').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('anon cannot insert', async () => {
    const { error } = await anon.from('trainers').insert({ naam: 'Blocked', rate_key: 'variabel' });
    expect(error).not.toBeNull();
  });

  it('authenticated user cannot insert', async () => {
    const { error } = await authed
      .from('trainers')
      .insert({ naam: 'Blocked', rate_key: 'variabel' });
    expect(error).not.toBeNull();
  });

  it('anon cannot read the new M2a tables (sync_runs, qual observations)', async () => {
    const runs = await anon.from('sync_runs').select('*');
    expect(runs.data ?? []).toHaveLength(0);
    const obs = await anon.from('trainer_theme_qual_observations').select('*');
    expect(obs.data ?? []).toHaveLength(0);
  });

  it('anon cannot write the new M2a tables', async () => {
    const runs = await anon.from('sync_runs').insert({ mode: 'apply', scope: { boardId: 'x' } });
    expect(runs.error).not.toBeNull();
  });
});
