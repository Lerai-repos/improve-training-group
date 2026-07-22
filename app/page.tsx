import { getUser } from '@lib/auth/queries'
import { SignOutForm } from '@lib/auth/components/sign-out-form'

export default async function HomePage() {
  const user = await getUser()

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-8 rounded-2xl border p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold">Welcome!</h1>
          <p className="mt-2 text-muted-foreground">You are logged in as:</p>
          <p className="mt-1 font-medium">{user.email}</p>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This is your base starter project. Start building your application here!
          </p>

          <SignOutForm />
        </div>
      </div>
    </div>
  )
}
