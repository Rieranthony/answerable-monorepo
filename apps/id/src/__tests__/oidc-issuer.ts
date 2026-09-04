import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";

export type OidcClaims = JWTPayload & {
  sub: string;
  oid?: string;
  tid?: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
  idp?: string;
  acct?: number;
  iss?: string;
};

export async function startOidcIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = crypto.randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const queued: OidcClaims[] = [];
  const codes = new Map<string, OidcClaims>();
  let origin = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_post",
            "client_secret_basic",
          ],
        });
      }
      if (request.method === "GET" && url.pathname === "/jwks") {
        return Response.json({ keys: [jwk] });
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        const claims = queued.shift();
        if (!redirectUri || !state || !claims) {
          return new Response("missing authorization input", { status: 400 });
        }
        const code = crypto.randomUUID();
        codes.set(code, claims);
        const location = new URL(redirectUri);
        location.searchParams.set("code", code);
        location.searchParams.set("state", state);
        return Response.redirect(location, 302);
      }
      if (request.method === "POST" && url.pathname === "/token") {
        const body = await request.formData();
        const code = String(body.get("code") ?? "");
        const claims = codes.get(code);
        const clientId =
          String(body.get("client_id") ?? "") ||
          atob(request.headers.get("authorization")?.replace(/^Basic /, "") ?? ":").split(":")[0]!;
        if (!claims || !clientId) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(code);
        const now = Math.floor(Date.now() / 1000);
        const { iss, ...payload } = claims;
        const idToken = await new SignJWT({ ...payload, azp: clientId })
          .setProtectedHeader({ alg: "RS256", kid })
          .setIssuer(iss ?? origin)
          .setAudience(clientId)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return Response.json({
          access_token: crypto.randomUUID(),
          token_type: "Bearer",
          id_token: idToken,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://${server.hostname}:${server.port}`;

  return {
    origin,
    enqueue(claims: OidcClaims) {
      queued.push(claims);
    },
    stop() {
      server.stop(true);
    },
  };
}

export type OidcIssuer = Awaited<ReturnType<typeof startOidcIssuer>>;
