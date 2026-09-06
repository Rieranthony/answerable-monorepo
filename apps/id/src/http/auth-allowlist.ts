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
      "Only grant_type=client_credentials is accepted. Authenticate the client with HTTP Basic (client_secret_basic) and send resource= to receive a JWT bound to that resource. Other grant types open with the OIDC provider milestone.",
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
