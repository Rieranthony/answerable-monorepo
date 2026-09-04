"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth/client"

const SCOPE_COPY: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Your name",
  email: "Your email address",
  offline_access: "Stay connected in the background",
}

interface ConsentFormProps {
  clientId: string
  clientName?: string
  clientUri?: string
  scope?: string
}

export function ConsentForm({
  clientId,
  clientName,
  clientUri,
  scope,
}: ConsentFormProps) {
  const [pending, setPending] = useState<"accept" | "deny" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const scopes = scope?.split(/\s+/).filter(Boolean) ?? []

  async function decide(accept: boolean) {
    setPending(accept ? "accept" : "deny")
    setMessage(null)

    try {
      // The client plugin carries the signed request from
      // window.location.search; only a narrowed scope needs repeating.
      const result = await authClient.oauth2.consent({
        accept,
        ...(accept && scope ? { scope } : {}),
      })

      const redirectUri =
        result.data && "redirect_uri" in result.data
          ? result.data.redirect_uri
          : null

      if (result.error || typeof redirectUri !== "string") {
        setMessage("We couldn't record your choice. Please try again.")
        setPending(null)
        return
      }

      window.location.assign(redirectUri)
    } catch {
      setMessage("We couldn't record your choice. Please try again.")
      setPending(null)
    }
  }

  return (
    <section aria-labelledby="consent-heading">
      {/* The API route for this action remains closed until the OAuth provider milestone. */}
      <h1 id="consent-heading" className="text-xl/6 font-bold">
        Allow access
      </h1>
      <p className="text-muted-foreground mt-2 text-sm/6">
        {clientName ?? "This app"} is asking to use your Answerable ID.
      </p>

      <dl className="mt-8 flex flex-col gap-4 text-sm/6">
        {clientName && (
          <div>
            <dt className="font-bold">App</dt>
            <dd className="break-words">{clientName}</dd>
          </div>
        )}
        {clientUri && (
          <div>
            <dt className="font-bold">App address</dt>
            <dd className="font-mono text-xs/4 break-all">{clientUri}</dd>
          </div>
        )}
        <div>
          <dt className="font-bold">Client ID</dt>
          <dd className="font-mono text-xs/4 break-all">{clientId}</dd>
        </div>
      </dl>

      <div className="mt-8">
        <h2 className="text-sm/6 font-bold">This will allow it to</h2>
        {scopes.length > 0 ? (
          <ul className="list-square mt-2 flex flex-col gap-2 pl-4 text-sm/6">
            {scopes.map((item) => (
              <li key={item}>
                {SCOPE_COPY[item] ?? (
                  <code className="font-mono text-xs/4">{item}</code>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm/6">
            No permissions were listed.
          </p>
        )}
      </div>

      <div className="mt-8 flex gap-2">
        <Button disabled={pending !== null} onClick={() => decide(true)}>
          {pending === "accept" ? "Allowing…" : "Accept"}
        </Button>
        <Button
          variant="secondary"
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
      </div>
      {message && (
        <p role="alert" className="mt-4 text-sm/6 font-medium">
          {message}
        </p>
      )}
    </section>
  )
}
