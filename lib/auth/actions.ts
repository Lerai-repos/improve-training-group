'use server'

import { createServerSupabaseClient } from '@lib/db'

import { loginSchema, registerSchema } from './schema'
import type { LoginActionState, RegisterActionState } from './types'

export async function login(
  prevState: LoginActionState,
  formData: FormData
): Promise<LoginActionState> {
  const validatedFields = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!validatedFields.success) {
    return { status: 'invalid_data' }
  }

  const { email, password } = validatedFields.data

  try {
    const supabase = await createServerSupabaseClient()

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      throw error
    }

    return { status: 'success' }
  } catch {
    return { status: 'failed' }
  }
}

export async function register(
  prevState: RegisterActionState,
  formData: FormData
): Promise<RegisterActionState> {
  const validatedFields = registerSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!validatedFields.success) {
    return { status: 'invalid_data' }
  }

  const { email, password } = validatedFields.data

  try {
    const supabase = await createServerSupabaseClient()

    const { error } = await supabase.auth.signUp({
      email,
      password,
    })

    if (error) {
      throw error
    }

    return { status: 'success' }
  } catch {
    return { status: 'failed' }
  }
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
}
