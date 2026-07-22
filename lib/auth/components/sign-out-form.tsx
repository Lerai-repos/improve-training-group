'use client'

import { useRouter } from 'next/navigation'

import { signOutAction } from '@lib/auth/actions'

export const SignOutForm = () => {
  const router = useRouter()

  const handleSignOut = async () => {
    try {
      await signOutAction()
      router.push('/login')
      router.refresh()
    } catch (error) {
      console.error('Error signing out:', error)
    }
  }

  return (
    <button
      onClick={handleSignOut}
      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
    >
      Sign out
    </button>
  )
}
