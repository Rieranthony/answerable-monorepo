"use client"

import { useEffect, useState, type FormEvent } from "react"
import Link from "next/link"
import { Button } from "@answerable/ui/components/button"
import { Input } from "@answerable/ui/components/input"
import { authClient } from "@/lib/auth/client"
import { describeError } from "@/lib/auth/error-copy"

export function SecurityForm({ error }: { error: string | null }) {
  const [email, setEmail] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [provider, setProvider] = useState("")
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState(
    error ? describeError(error).body : null,
  )

  useEffect(() => {
    let active = true
    void authClient
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        setEmail(data?.user.email ?? null)
        if (error)
          setMessage("We couldn't check your sign-in. Please try again.")
      })
      .catch(() => {
        if (active)
          setMessage("We couldn't check your sign-in. Please try again.")
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function start(purpose: "reauthenticate" | "link") {
    setPending(true)
    setMessage(null)
    try {
      const result = await authClient.$fetch<{ url: string }>(
        `/sso/${purpose}`,
        {
          method: "POST",
          body: {
            callbackURL: `${window.location.origin}/security`,
            errorCallbackURL: `${window.location.origin}/security`,
            ...(purpose === "link" ? { providerId: provider.trim() } : {}),
          },
        },
      )
      if (result.error || !result.data?.url) {
        const code =
          result.error &&
          "code" in result.error &&
          typeof result.error.code === "string"
            ? result.error.code
            : null
        setMessage(describeError(code).body)
        return
      }
      window.location.assign(result.data.url)
    } catch {
      setMessage("We couldn't start verification. Please try again.")
    } finally {
      setPending(false)
    }
  }

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void start("link")
  }

  if (checking)
    return (
      <p className="text-muted-foreground text-sm/6">Checking your sign-in…</p>
    )

  return (
    <section aria-labelledby="security-heading">
      <h1 id="security-heading" className="text-xl/6 font-bold">
        Account security
      </h1>
      {email ? (
        <>
          <p className="mt-2 text-sm/6">Signed in as {email}</p>
          <h2 className="mt-8 text-base/6 font-semibold">
            Verify your sign-in
          </h2>
          <p className="text-muted-foreground mt-2 text-sm/6">
            Security changes require a company sign-in from the last five
            minutes. After verifying, return to your action and try it again.
          </p>
          <Button
            className="mt-4"
            disabled={pending}
            onClick={() => void start("reauthenticate")}
          >
            Verify sign-in
          </Button>
          <h2 className="mt-8 text-base/6 font-semibold">
            Connect another work account
          </h2>
          <p className="text-muted-foreground mt-2 text-sm/6">
            Keep this Answerable account when signing in through another
            organisation. Verify your current sign-in first, then sign in to the
            account you want to connect. Accounts already connected to another
            person cannot be moved here.
          </p>
          <form className="mt-4 flex flex-col gap-4" onSubmit={connect}>
            <label className="flex flex-col gap-2 text-sm/6">
              Organisation sign-in ID
              <Input
                name="provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                required
                maxLength={200}
                autoComplete="off"
                aria-describedby="provider-help"
              />
            </label>
            <p id="provider-help" className="text-muted-foreground text-sm/6">
              Use the sign-in ID supplied by that organisation’s administrator.
            </p>
            <Button type="submit" disabled={pending || !provider.trim()}>
              Connect work account
            </Button>
          </form>
        </>
      ) : (
        <p className="mt-4 text-sm/6">
          <Link href="/login" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          to verify or connect a work account.
        </p>
      )}
      {message && (
        <p role="alert" className="mt-4 text-sm/6">
          {message}
        </p>
      )}
    </section>
  )
}
