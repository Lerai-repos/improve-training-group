import { redirect } from 'next/navigation';

import { createServerSupabaseClient } from '@lib/db';

import type { AuthUser, UserType } from './types';

export async function getSession() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }
  return session;
}

export async function getUser(): Promise<AuthUser> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  const userType: UserType = user.email?.includes('guest') ? 'guest' : 'regular';

  return {
    id: user.id,
    email: user.email || '',
    type: userType,
  };
}
