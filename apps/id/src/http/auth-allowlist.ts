type RequestBodyObject = {
  required?: boolean;
  content: Record<
    string,
    {
      schema: {
        type: "object";
        required?: string[];
        properties: Record<
          string,
          { type: "string"; enum?: string[]; format?: string }
        >;
      };
    }
  >;
};

export type PublicAuthRoute = {
  method: "GET" | "POST";
  path: string;
  operationId: string;
  summary: string;
  tag: "Sign-in" | "Session" | "Token";
  description?: string;
  requestBody?: RequestBodyObject;
  security?: Array<Record<string, string[]>>;
};

export const publicAuthRoutes: ReadonlyArray<PublicAuthRoute> = [
  {
    method: "GET",
    path: "/auth/jwks",
    operationId: "getJwks",
    summary: "Read public token signing keys",
    tag: "Token",
  },
  {
    method: "GET",
    path: "/auth/oauth2/authorize",
    operationId: "authorizeOAuth",
    summary: "Start a user authorisation with PKCE",
    tag: "Token",
  },
  {
    method: "POST",
    path: "/auth/oauth2/flow",
    operationId: "readOAuthFlow",
    summary:
      "Read the validated application request and available organisations",
    tag: "Token",
    security: [{ apiKeyCookie: [] }],
  },
  {
    method: "POST",
    path: "/auth/oauth2/continue",
    operationId: "continueOAuthFlow",
    summary: "Select an independently authenticated organisation",
    tag: "Token",
    security: [{ apiKeyCookie: [] }],
  },
  {
    method: "POST",
    path: "/auth/oauth2/consent",
    operationId: "consentOAuth",
    summary: "Accept or deny access for this authorisation",
    tag: "Token",
    security: [{ apiKeyCookie: [] }],
  },
  {
    method: "GET",
    path: "/auth/oauth2/userinfo",
    operationId: "getUserInfo",
    summary: "Read identity claims using an active access token",
    tag: "Token",
  },
  {
    method: "POST",
    path: "/auth/oauth2/userinfo",
    operationId: "postUserInfo",
    summary: "Read identity claims using an active access token",
    tag: "Token",
  },
  {
    method: "POST",
    path: "/auth/oauth2/revoke",
    operationId: "revokeOAuthToken",
    summary: "Revoke an opaque access token or refresh family",
    tag: "Token",
  },
  {
    method: "POST",
    path: "/auth/sso/reauthenticate",
    operationId: "reauthenticateSso",
    security: [{ apiKeyCookie: [] }],
    summary: "Reauthenticate the current work identity",
    tag: "Sign-in",
  },
  {
    method: "POST",
    path: "/auth/sso/link",
    operationId: "linkSso",
    security: [{ apiKeyCookie: [] }],
    summary: "Bind another independently verified work identity",
    tag: "Sign-in",
  },
  {
    method: "POST",
    path: "/auth/oauth2/token",
    operationId: "issueToken",
    summary:
      "Exchange an authorisation code, refresh token or client credentials",
    tag: "Token",
    description:
      "Supports authorization_code with S256 PKCE, refresh_token and client_credentials. User flows bind a single independently authenticated membership, registered client and optional exact resource. Login requires a client-only authorization_code capability and assignment; resource access additionally requires an exact-pair capability and assignment. Renewal requires a separate matching refresh_token capability. Consent applies to each new flow except explicit first-party bypass. Codes and refresh tokens retain native expiry, single-use and rotation checks. Current authentication provenance, deletion state, grant revocation and permissions are rechecked before every exchange, including cached native refresh responses. Login-only access tokens are opaque; resource access tokens are JWTs. Client credentials require exactly one resource and an effective owner/client/resource capability. Scope widening is refused. Required issuance audit and native effects commit together. Lock contention, statement cancellation or unavailable audit storage returns 503 temporarily_unavailable with Retry-After: 1. Retry with fresh client authentication; a new assertion is required for private_key_jwt.",
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: ["grant_type"],
            properties: {
              grant_type: {
                type: "string",
                enum: [
                  "client_credentials",
                  "authorization_code",
                  "refresh_token",
                ],
              },
              resource: { type: "string", format: "uri" },
              scope: { type: "string" },
              code: { type: "string" },
              code_verifier: { type: "string" },
              redirect_uri: { type: "string", format: "uri" },
              refresh_token: { type: "string" },
              client_id: { type: "string" },
              client_secret: { type: "string" },
              client_assertion: { type: "string" },
              client_assertion_type: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    method: "GET",
    path: "/auth/ok",
    operationId: "ok",
    summary: "Check that Answerable ID is reachable",
    tag: "Session",
  },
  {
    method: "POST",
    path: "/auth/sign-in/sso",
    operationId: "signInWithSso",
    summary: "Start sign-in through the organisation's identity provider",
    tag: "Sign-in",
  },
  {
    method: "GET",
    path: "/auth/sso/callback",
    operationId: "ssoCallback",
    summary: "Complete sign-in after the identity provider redirects back",
    tag: "Sign-in",
  },
  {
    method: "GET",
    path: "/auth/get-session",
    operationId: "getSession",
    summary: "Read the current session",
    tag: "Session",
  },
  {
    method: "POST",
    path: "/auth/sign-out",
    operationId: "signOut",
    summary: "End the current session",
    tag: "Session",
  },
];

const allowedAuthRoutes = new Set(
  publicAuthRoutes.map(({ method, path }) => `${method} ${path}`),
);

export function isAllowedAuthRoute(method: string, path: string): boolean {
  return allowedAuthRoutes.has(`${method.toUpperCase()} ${path}`);
}
