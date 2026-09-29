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
