import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { sessionCookie, testClient, testConfig } from "@/lib/oauth-test/runtime"

export const dynamic = "force-dynamic"
export const metadata = {
  title: "Local OAuth test",
  robots: { index: false, follow: false },
}
const messages: Record<string, string> = {
  "signed-in":
    "Sign-in completed. The identity below was verified against ID’s signing keys.",
  refresh:
    "Tokens refreshed. The latest refresh token is now held by this app.",
  revoke:
    "ID accepted the token revocation requests. Existing signed access tokens may remain usable until expiry. Your ID browser session is unchanged.",
  logout: "The test app session is cleared. You are still signed in to ID.",
  "login-failed":
    "Could not start sign-in. Check the local client configuration and ID service.",
  "callback-failed":
    "Sign-in was denied, expired or could not be verified. Start again from this page.",
  "refresh-failed": "Refresh failed or was unavailable. Sign in again.",
  "revoke-failed": "Revocation could not be confirmed. Retry the request.",
}
function Action({
  action,
  children,
  disabled = false,
}: {
  action: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <form action={`/api/oauth-test/${action}`} method="post">
      <button
        disabled={disabled}
        className="rounded-md border px-4 py-2 text-sm disabled:opacity-40"
      >
        {children}
      </button>
    </form>
  )
}
export default async function OAuthTestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NODE_ENV !== "development") notFound()
  const config = testConfig()
  const params = await searchParams
  const message =
    typeof params.result === "string" ? messages[params.result] : undefined
  const view = config
    ? testClient().view((await cookies()).get(sessionCookie)?.value ?? "")
    : null
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-bold">Local OAuth test</h1>
      <p className="mt-3 text-sm">
        This website is an independent OAuth client. Answerable ID owns login,
        company sign-in and consent.
      </p>
      <p className="text-muted-foreground mt-2 text-sm">
        Development only. Tokens stay on this server. Restarting the web process
        clears test sessions.
      </p>
      {!config ? (
        <p role="status" className="mt-6">
          Configure OAUTH_TEST_ISSUER, OAUTH_TEST_CLIENT_ID,
          OAUTH_TEST_CLIENT_SECRET and OAUTH_TEST_REDIRECT_URI in
          apps/web/.env.local.
        </p>
      ) : (
        <>
          <dl className="mt-6 space-y-2 text-sm">
            <dt className="font-bold">Issuer</dt>
            <dd>{config.issuer}</dd>
            <dt className="font-bold">Client</dt>
            <dd>{config.clientId}</dd>
            <dt className="font-bold">App callback</dt>
            <dd className="break-all">{config.redirectUri}</dd>
          </dl>
          {message && (
            <p role="status" className="my-6 rounded-md border p-4 text-sm">
              {message}
            </p>
          )}
          {view?.identity ? (
            <section className="my-6 rounded-md border p-5">
              <h2 className="font-bold">Verified identity</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <dt>Subject</dt>
                <dd>{view.identity.sub}</dd>
                <dt>Name</dt>
                <dd>{view.identity.name ?? "Not supplied"}</dd>
                <dt>Email</dt>
                <dd>{view.identity.email ?? "Not supplied"}</dd>
                <dt>Granted scopes</dt>
                <dd>{view.scopes}</dd>
                <dt>Access token expiry</dt>
                <dd>
                  {view.tokenExpires
                    ? new Date(view.tokenExpires).toISOString()
                    : "Unavailable"}
                </dd>
              </dl>
            </section>
          ) : (
            <p className="my-6 text-sm">No test app session.</p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <Action action="login">Sign in with Answerable ID</Action>
            <Action action="refresh" disabled={!view?.canRefresh}>
              Refresh tokens
            </Action>
            <Action action="revoke" disabled={!view?.canRevoke}>
              Revoke tokens
            </Action>
            <Action action="logout" disabled={!view?.identity}>
              Sign out of this app
            </Action>
          </div>
        </>
      )}
    </main>
  )
}
