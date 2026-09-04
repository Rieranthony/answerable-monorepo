"use client"

import { type FormEvent, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient } from "@/lib/auth/client"
import { describeError } from "@/lib/auth/error-copy"
import type { LoginRoute } from "@/lib/auth/login-routing"

interface LoginFormProps {
  route: LoginRoute
  oauthQuery: string | null
}

export function LoginForm({ route, oauthQuery }: LoginFormProps) {
  const [email, setEmail] = useState(
    route.mode === "form" ? (route.email ?? "") : "",
  )
  const [showForm, setShowForm] = useState(route.mode === "form")
  const [checkingSession, setCheckingSession] = useState(true)
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const autoStarted = useRef(false)

  useEffect(() => {
    let active = true

    void authClient
      .getSession()
      .then(({ data }) => {
        if (active) setSessionEmail(data?.user.email ?? null)
      })
      // An unreachable API means no session; the form still renders.
      .catch(() => {
        if (active) setSessionEmail(null)
      })
      .finally(() => {
        if (active) setCheckingSession(false)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (
      checkingSession ||
      sessionEmail ||
      showForm ||
      route.mode !== "auto" ||
      autoStarted.current
    ) {
      return
    }

    autoStarted.current = true
    void startSSO({ organizationSlug: route.organizationSlug })
  }, [checkingSession, route, sessionEmail, showForm])

  async function startSSO(
    identity: { email: string } | { organizationSlug: string },
  ) {
    setMessage(null)

    try {
      const result = await authClient.signIn.sso({
        ...identity,
        callbackURL: window.location.href,
        errorCallbackURL: `${window.location.origin}/error`,
      })

      if (result.error || !result.data?.url) {
        setMessage(describeError("provider_not_found").body)
        return
      }

      window.location.assign(result.data.url)
    } catch {
      setMessage(describeError("provider_not_found").body)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    await startSSO({ email })
    setPending(false)
  }

  async function signOut() {
    setPending(true)
    const result = await authClient.signOut()
    setPending(false)

    if (result.error) {
      setMessage("We couldn't sign you out. Please try again.")
      return
    }

    setSessionEmail(null)
    setShowForm(true)
  }

  if (checkingSession) {
    return (
      <p className="text-muted-foreground text-sm/6">Checking your sign-in…</p>
    )
  }

  if (sessionEmail) {
    return (
      <section aria-labelledby="signed-in-heading">
        <h1 id="signed-in-heading" className="text-xl/6 font-bold">
          Signed in
        </h1>
        <p className="mt-2 text-sm/6">Signed in as {sessionEmail}</p>
        {oauthQuery && (
          <p className="text-muted-foreground mt-2 text-sm/6">
            Returning you to the app…
          </p>
        )}
        <Button className="mt-8" disabled={pending} onClick={signOut}>
          {pending ? "Signing out…" : "Sign out"}
        </Button>
        {message && (
          <p role="alert" className="mt-4 text-sm/6 font-medium">
            {message}
          </p>
        )}
      </section>
    )
  }

  if (!showForm && route.mode === "auto") {
    return (
      <section aria-labelledby="sign-in-heading">
        <h1 id="sign-in-heading" className="text-xl/6 font-bold">
          Sign in
        </h1>
        <p className="text-muted-foreground mt-2 text-sm/6">
          Taking you to {route.organizationSlug} sign-in…
        </p>
        <button
          type="button"
          className="mt-8 w-fit text-left text-sm/6 underline underline-offset-4"
          onClick={() => {
            setShowForm(true)
            setMessage(null)
          }}
        >
          Use another email
        </button>
        {message && (
          <p role="alert" className="mt-4 text-sm/6 font-medium">
            {message}
          </p>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading" className="text-xl/6 font-bold">
        Sign in
      </h1>
      <p className="text-muted-foreground mt-2 text-sm/6">
        Use your work email. We&apos;ll take you to your organisation&apos;s
        login.
      </p>
      <form className="mt-8 flex flex-col gap-4" onSubmit={submit}>
        <label className="flex flex-col gap-2 text-sm/6">
          Work email
          <Input
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
            placeholder="you@company.com"
            className="text-sm"
          />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Continuing…" : "Continue"}
        </Button>
      </form>
      {message && (
        <p role="alert" className="mt-4 text-sm/6 font-medium">
          {message}
        </p>
      )}
    </section>
  )
}
