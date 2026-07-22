import { createServerSupabaseClient } from '@lib/db'

export async function signInWithEmail(email: string, password: string) {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    throw error
  }
  return data
}

export async function signUpWithEmail(email: string, password: string) {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) {
    throw error
  }
  return data
}

export async function signOut() {
  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.signOut()
  if (error) {
    throw error
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}@example.com`
  const password = `guest-${Date.now()}-${Math.random().toString(36).substring(7)}`

  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) {
    throw error
  }
  return data
}
