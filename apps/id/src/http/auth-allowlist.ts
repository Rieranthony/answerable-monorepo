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
};

export const publicAuthRoutes: ReadonlyArray<PublicAuthRoute> = [
  {
    method: "POST",
    path: "/auth/oauth2/token",
    operationId: "issueToken",
    summary: "Obtain an access token with client credentials",
    tag: "Token",
    description:
      "Only grant_type=client_credentials is accepted. An effective platform-approved capability for the exact owner/client/resource is required; registration and a compatibility link alone do not grant access. Omitted scopes default to the intersection of client, resource and capability ceilings. Authenticate the client with HTTP Basic (client_secret_basic) and send resource= to receive a JWT bound to that resource. At most two machine issuance transactions per verified owner organisation proceed concurrently across instances sharing this database. Excess issuance returns 503 temporarily_unavailable with Retry-After: 1. This limit starts after authentication and policy locking; it does not bound connection checkout or guarantee tenant fairness. Each database lock wait during issuance is limited to two seconds. Database statements have a configurable server-side deadline (ten seconds by default). Lock contention, statement cancellation or an unavailable issuance audit write returns 503 temporarily_unavailable with Retry-After: 1; retry after that delay with fresh client authentication (including a new assertion for private_key_jwt). Successful issuance commits an oauth.token.issued audit fact before returning the token. This is not a total request deadline. Other grant types open with the OIDC provider milestone.",
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: ["grant_type", "resource"],
            properties: {
              grant_type: { type: "string", enum: ["client_credentials"] },
              resource: { type: "string", format: "uri" },
              scope: { type: "string" },
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

export const allowedTokenGrantTypes = new Set(["client_credentials"]);

export async function inspectTokenRequest(
  request: Request,
): Promise<Response | null> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  try {
    const form = await request.clone().formData();
    const grantType = form.get("grant_type");
    if (grantType !== null && !allowedTokenGrantTypes.has(String(grantType))) {
      return Response.json(
        {
          error: "unsupported_grant_type",
          error_description: "Only client_credentials is available.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return null;
  }
  return null;
}
