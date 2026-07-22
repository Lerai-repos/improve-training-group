'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { toast } from '@components/toast'
import { AuthForm } from '@lib/auth/components/auth-form'
import { SubmitButton } from '@lib/auth/components/submit-button'
import { register } from '@lib/auth/actions'
import type { RegisterActionState } from '@lib/auth/types'

export default function Page() {
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [isSuccessful, setIsSuccessful] = useState(false)

  const [state, setState] = useState<RegisterActionState>({
    status: 'idle',
  })

  useEffect(() => {
    if (!state) {
      return
    }

    if (state.status === 'failed') {
      toast({
        type: 'error',
        description: 'Registration failed! User might already exist.',
      })
    } else if (state.status === 'invalid_data') {
      toast({
        type: 'error',
        description: 'Failed validating your submission!',
      })
    } else if (state.status === 'success') {
      setIsSuccessful(true)
      router.refresh()
      router.push('/')
    }
  }, [state, router])

  const handleSubmit = async (formData: FormData) => {
    setEmail(formData.get('email') as string)
    const result = await register(state, formData)
    setState(result)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-12 overflow-hidden rounded-2xl">
        <div className="flex flex-col items-center justify-center gap-2 px-4 text-center sm:px-16">
          <h3 className="text-xl font-semibold dark:text-zinc-50">Sign Up</h3>
          <p className="text-sm text-gray-500 dark:text-zinc-400">
            Create your account to get started
          </p>
        </div>
        <AuthForm action={handleSubmit} defaultEmail={email}>
          <SubmitButton isSuccessful={isSuccessful}>Sign up</SubmitButton>
          <p className="mt-4 text-center text-sm text-gray-600 dark:text-zinc-400">
            {'Already have an account? '}
            <Link
              href="/login"
              className="font-semibold text-gray-800 hover:underline dark:text-zinc-200"
            >
              Sign in
            </Link>
            {' instead.'}
          </p>
        </AuthForm>
      </div>
    </div>
  )
}
