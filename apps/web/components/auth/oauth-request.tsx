"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@answerable/ui/components/button"
import { authClient } from "@/lib/auth/client"
import {
  continueOAuthFlow,
  decideOAuthConsent,
  loadOAuthFlow,
  type OAuthFlow,
} from "@/lib/auth/oauth-flow"

const scopeCopy: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Read your name",
  email: "Read your email address",
  offline_access: "Stay connected after you leave",
}

export function OAuthRequest({ consent = false }: { consent?: boolean }) {
  const [flow, setFlow] = useState<OAuthFlow | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void loadOAuthFlow()
      .then((data) => {
        if (active) setFlow(data)
      })
      .catch(() => {
        if (active)
          setMessage(
            "This request has expired or is unavailable. Start again from the application.",
          )
      })
    return () => {
      active = false
    }
  }, [])

  async function run(action: () => Promise<void>) {
    setPending(true)
    setMessage(null)
    try {
      await action()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This request is unavailable. Please try again.",
      )
    } finally {
      setPending(false)
    }
  }

  async function signIn(organizationSlug: string) {
    const response = await authClient.signIn.sso({
      organizationSlug,
      callbackURL: window.location.href,
      errorCallbackURL: `${window.location.origin}/error`,
    })
    if (response.error || !response.data?.url)
      throw new Error(
        "We couldn't start your organisation's sign-in. Please try again.",
      )
    window.location.assign(response.data.url)
  }

  const selected = flow?.memberships.find(
    (member) => member.memberId === flow.selectedMemberId,
  )
  return (
    <section aria-labelledby="oauth-heading">
      <h1 id="oauth-heading" className="text-xl/6 font-bold">
        {consent ? "Allow access" : "Choose an organisation"}
      </h1>
      {!flow && !message && (
        <p className="text-muted-foreground mt-4 text-sm/6" role="status">
          Checking the request…
        </p>
      )}
      {flow && (
        <>
          <p className="text-muted-foreground mt-2 text-sm/6">
            {flow.client.name ?? "This application"} is asking to use your
            Answerable ID.
          </p>
          <dl className="mt-6 flex flex-col gap-3 text-sm/6">
            <div>
              <dt className="font-bold">Application</dt>
              <dd className="break-words">
                {flow.client.name ?? flow.client.clientId}
              </dd>
            </div>
            {flow.client.uri && (
              <div>
                <dt className="font-bold">Application address</dt>
                <dd className="break-all">{flow.client.uri}</dd>
              </div>
            )}
            {flow.resource && (
              <div>
                <dt className="font-bold">Service</dt>
                <dd>{flow.resource.name}</dd>
                <dd className="text-muted-foreground break-all">
                  {flow.resource.identifier}
                </dd>
              </div>
            )}
            {selected && (
              <div>
                <dt className="font-bold">Organisation</dt>
                <dd>{selected.name}</dd>
              </div>
            )}
          </dl>
          {consent && flow.status === "consent" && selected ? (
            <>
              <h2 className="mt-6 text-sm/6 font-bold">Requested access</h2>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-sm/6">
                {flow.scopes.map((scope) => (
                  <li key={scope}>
                    {scopeCopy[scope] ?? (
                      <code className="font-mono text-xs">{scope}</code>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex gap-2">
                <Button
                  disabled={pending}
                  onClick={() => run(() => decideOAuthConsent(true))}
                >
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => decideOAuthConsent(false))}
                >
                  Deny
                </Button>
              </div>
              <p className="text-muted-foreground mt-4 text-sm/6">
                To use another organisation, deny this request and start again
                from the application.
              </p>
            </>
          ) : flow.status === "selection" ? (
            <>
              <p className="mt-6 text-sm/6">
                Choose the organisation you want to use. Each organisation
                requires its own company sign-in.
              </p>
              <ul className="mt-4 space-y-4">
                {flow.memberships.map((member) => (
                  <li
                    key={member.memberId}
                    className="border-border flex items-center justify-between gap-4 border-b pb-4"
                  >
                    <span className="text-sm/6">{member.name}</span>
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          member.authenticated
                            ? continueOAuthFlow(member.memberId)
                            : signIn(member.slug),
                        )
                      }
                    >
                      {member.authenticated ? "Continue" : "Sign in"}
                    </Button>
                  </li>
                ))}
              </ul>
              {flow.memberships.length === 0 && (
                <p className="mt-4 text-sm/6">
                  No organisation is available for this account.
                </p>
              )}
              <p className="mt-6 text-sm/6">
                <Link href="/security" className="underline underline-offset-4">
                  Connect another work account
                </Link>
              </p>
            </>
          ) : (
            <p className="mt-6 text-sm/6">
              Return to the application&apos;s access request to continue.
            </p>
          )}
        </>
      )}
      {message && (
        <p role="alert" className="mt-4 text-sm/6">
          {message}
        </p>
      )}
    </section>
  )
}
