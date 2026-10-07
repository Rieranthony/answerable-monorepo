import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/client"

/** An in-memory OAuth client, registered in ID ahead of time, as Claude Code is with `--client-id`. Its `state` holds what the SDK saved: the authorisation URL, the PKCE verifier, the tokens and the discovery result. */
export function oauthProvider({ clientId, callback }: { clientId: string; callback: string }) {
  const state: {
    authorizationUrl?: URL
    verifier?: string
    tokens?: Awaited<ReturnType<OAuthClientProvider["tokens"]>>
    discovery?: OAuthDiscoveryState
  } = {}
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: {
      client_name: "MCP acceptance",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: () => ({ client_id: clientId }),
    tokens: () => state.tokens,
    saveTokens: tokens => {
      state.tokens = tokens
    },
    redirectToAuthorization: url => {
      state.authorizationUrl = url
    },
    saveCodeVerifier: verifier => {
      state.verifier = verifier
    },
    // The SDK saves the verifier before it redirects, so it exists by the code exchange.
    codeVerifier: () => state.verifier!,
    saveDiscoveryState: discovery => {
      state.discovery = discovery
    },
    discoveryState: () => state.discovery,
  }
  return { provider, state }
}

/** What `oauthProvider` returns: the provider to hand to an MCP client, and the state it fills. */
export type OAuthSession = ReturnType<typeof oauthProvider>

/** Refresh the session's tokens for `resource` as the public client `clientId`, and throw unless ID answers `400 invalid_grant`, as it does once the organisation is disabled. */
export async function refreshRefused({ state }: OAuthSession, clientId: string, resource: string) {
  const endpoint = state.discovery?.authorizationServerMetadata?.token_endpoint
  if (!endpoint) throw new Error("The session has no token endpoint: it never signed in")
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: String(state.tokens?.refresh_token), resource }),
  })
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined
  if (response.status !== 400 || body?.error !== "invalid_grant") throw new Error(`ID answered the refresh with ${response.status} ${JSON.stringify(body)}, not 400 invalid_grant`)
}
