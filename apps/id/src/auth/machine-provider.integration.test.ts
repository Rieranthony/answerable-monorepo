import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { machineIdentity } from "./machine-identity.ts";
import { answerableSchema } from "./answerable-schema.ts";
import { authDatabaseAdapter } from "./database-adapter.ts";
import { betterAuth, getCurrentAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { eq, sql } from "drizzle-orm";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import { machineOAuthProvider } from "./machine-provider.ts";

let connection: DatabaseConnection;
const environment = testEnvironment();
const organizationId = createId();
const clientId = "transaction-proof";
const secret = "transaction-proof-secret";
const resource = "https://resource.example/proof";

beforeAll(async () => {
  connection = createDatabase(environment);
  await connection.db.execute(
    sql`truncate organizations, oauth_clients, oauth_resources, verifications cascade`,
  );
  await connection.db
    .insert(schema.organizations)
    .values({ id: organizationId, slug: "provider-proof", name: "Proof" });
  await connection.db.insert(schema.oauthClients).values({
    id: createId(),
    organizationId,
    clientId,
    clientSecret: hashClientSecret(secret),
    name: "Transaction proof",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "client_secret_basic",
    clientCredentialsScopes: ["proof:read"],
  });
  await connection.db.insert(schema.oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Proof",
    allowedScopes: ["proof:read"],
  });
  await connection.db
    .insert(schema.oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await approveMachineCapability(connection.db, {
    organizationId,
    clientId,
    resource,
    scopes: ["proof:read"],
  });
});
afterAll(async () => connection.close());

function testAuth(
  accessToken?: NonNullable<OAuthProviderExtension["claims"]>["accessToken"],
  failSigning = false,
) {
  return betterAuth({
    baseURL: environment.betterAuthUrl,
    basePath: "/auth",
    secret: environment.betterAuthSecret,
    database: authDatabaseAdapter(connection.db),
    advanced: { database: { generateId: createId } },
    plugins: [
      answerableSchema(),
      jwt({
        ...(failSigning
          ? {
              jwks: {
                remoteUrl: "https://keys.example/jwks",
                keyPairConfig: { alg: "EdDSA" as const },
              },
            }
          : {}),
        jwt: {
          issuer: environment.betterAuthUrl,
          ...(failSigning
            ? {
                sign: async () => {
                  throw new Error("signing unavailable");
                },
              }
            : {}),
        },
        schema: { jwks: { modelName: "jwk" } },
      }),
      machineOAuthProvider(connection.db, {
        loginPage: "https://pages.example/login",
        consentPage: "https://pages.example/consent",
        storeClientSecret: "hashed",
        extensions: [machineIdentity(), { claims: { accessToken } }],
      }),
    ],
  });
}

for (const failure of ["none", "policy", "signing", "credentials"] as const) {
  test(`provider transaction: verified client and atomic extension write (${failure})`, async () => {
    const marker = createId();
    let called = false;
    const auth = testAuth(
      async ({ ctx, client, grantType, scopes, resources }) => {
        called = true;
        expect(client.clientId).toBe(clientId);
        expect(grantType).toBe("client_credentials");
        expect(scopes).toEqual(["proof:read"]);
        expect(resources).toEqual([resource]);
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        await adapter.create({
          model: "verification",
          data: {
            identifier: marker,
            value: "policy evaluated",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        if (failure === "policy")
          throw new APIError("FORBIDDEN", { error: "access_denied" });
        return { proof_client: client.clientId };
      },
      failure === "signing",
    );
    const response = await auth.handler(
      new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${failure === "credentials" ? "wrong" : secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-request-id": marker,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource,
          scope: "proof:read",
        }),
      }),
    );
    const body = response.status === 200 ? await response.json() : {};
    const stored = await connection.db
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.identifier, marker));
    const events = await connection.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.requestId, marker));
    expect(events).toHaveLength(1);
    if (failure === "credentials")
      expect(events[0]).toMatchObject({
        schemaVersion: 3,
        action: "oauth.token.rejected",
        organizationId: null,
        outcome: "denied",
        reason: "invalid_client",
        data: {
          stage: "authentication",
          authenticatedClient: null,
          decision: null,
        },
      });
    if (failure === "policy" || failure === "signing")
      expect(events[0]).toMatchObject({
        action: "oauth.token.rejected",
        outcome: failure === "policy" ? "denied" : "failure",
        reason: failure === "policy" ? "access_denied" : "issuance_failed",
        data: {
          stage: "issuance",
          authenticatedClient: { clientId, organizationId },
        },
      });
    if (failure === "none") {
      expect(response.status).toBe(200);
      expect(decodeJwt(body.access_token).proof_client).toBe(clientId);
      expect(stored).toHaveLength(1);
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.access_token).toBeUndefined();
      expect(stored).toHaveLength(0);
    }
    expect(called).toBe(failure !== "credentials");
  });
}

test("client assertions remain consumed when issuance fails", async () => {
  const keyClientId = "assertion-transaction-proof";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  await connection.db.insert(schema.oauthClients).values({
    id: createId(),
    organizationId,
    clientId: keyClientId,
    name: "Key client",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "private_key_jwt",
    clientCredentialsScopes: ["proof:read"],
    jwks: JSON.stringify({
      keys: [{ ...(await exportJWK(publicKey)), kid: "proof", alg: "RS256" }],
    }),
  });
  await connection.db
    .insert(schema.oauthClientResources)
    .values({ id: createId(), clientId: keyClientId, resourceId: resource });
  await approveMachineCapability(connection.db, {
    organizationId,
    clientId: keyClientId,
    resource,
    scopes: ["proof:read"],
  });
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "proof" })
    .setIssuer(keyClientId)
    .setSubject(keyClientId)
    .setAudience(`${environment.betterAuthUrl}/auth/oauth2/token`)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setJti(createId())
    .sign(privateKey);
  let evaluations = 0;
  const auth = testAuth(async () => {
    evaluations++;
    throw new APIError("FORBIDDEN", { error: "access_denied" });
  });
  const request = () =>
    new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource,
        client_id: keyClientId,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });
  const first = await auth.handler(request());
  expect(first.status).toBe(403);
  expect(await first.json()).toMatchObject({ error: "access_denied" });
  const repeated = await auth.handler(request());
  expect(repeated.status).toBe(400);
  expect(await repeated.json()).toMatchObject({ error: "invalid_client" });
  expect(evaluations).toBe(1);
});

test("machine policy rejects other grants, missing or repeated audiences and excessive scopes", async () => {
  const auth = testAuth();
  for (const [entries, code] of [
    [[["grant_type", "refresh_token"]], "unsupported_grant_type"],
    [[["grant_type", "client_credentials"]], "invalid_target"],
    [
      [
        ["grant_type", "client_credentials"],
        ["resource", resource],
        ["resource", resource],
      ],
      "invalid_target",
    ],
    [
      [
        ["grant_type", "client_credentials"],
        ["resource", resource],
        ["scope", "other:read"],
      ],
      "invalid_scope",
    ],
    [
      [
        ["grant_type", "client_credentials"],
        ["resource", resource],
        ["scope", ""],
      ],
      "invalid_scope",
    ],
  ] as const) {
    const response = await auth.handler(
      new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(entries.map(([key, value]) => [key, value])),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: code });
  }
  // Server-side callers share the policy without an HTTP request object.
  await connection.db
    .update(schema.oauthClients)
    .set({ tokenEndpointAuthMethod: "client_secret_post" })
    .where(eq(schema.oauthClients.clientId, clientId));
  const body = {
    grant_type: "client_credentials",
    resource,
    client_id: clientId,
    client_secret: secret,
  };
  try {
    const granted = await auth.api.oauth2Token({ body });
    expect(granted.scope).toBe("proof:read");
    await connection.db
      .update(schema.oauthClients)
      .set({ clientCredentialsScopes: ["openid"] })
      .where(eq(schema.oauthClients.clientId, clientId));
    await expect(auth.api.oauth2Token({ body })).rejects.toMatchObject({
      body: { error: "invalid_scope" },
    });
  } finally {
    await connection.db
      .update(schema.oauthClients)
      .set({
        tokenEndpointAuthMethod: "client_secret_basic",
        clientCredentialsScopes: ["proof:read"],
      })
      .where(eq(schema.oauthClients.clientId, clientId));
  }
});

test("private resources accept only their owning machine tenant even with a foreign compatibility link", async () => {
  const foreignId = createId();
  await connection.db
    .insert(schema.organizations)
    .values({ id: foreignId, slug: `foreign-${foreignId}`, name: "Foreign" });
  for (const owner of [organizationId, foreignId]) {
    const target = `https://${createId()}.example/private`;
    await connection.db.insert(schema.oauthResources).values({
      id: createId(),
      identifier: target,
      name: "Private",
      classification: "tenant_owned",
      organizationId: owner,
      allowedScopes: ["proof:read"],
    });
    await connection.db
      .insert(schema.oauthClientResources)
      .values({ id: createId(), clientId, resourceId: target });
    if (owner === organizationId)
      await approveMachineCapability(connection.db, {
        organizationId,
        clientId,
        resource: target,
        scopes: ["proof:read"],
      });
    const response = await testAuth().handler(
      new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource: target,
          scope: "proof:read",
        }),
      }),
    );
    const body = await response.json();
    if (owner === organizationId) {
      expect(response.status).toBe(200);
      expect(decodeJwt(body.access_token)).toMatchObject({
        aud: target,
        organization_id: organizationId,
      });
    } else {
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ error: "invalid_target" });
      expect(body.access_token).toBeUndefined();
    }
  }
});

test("registration and compatibility alone do not authorise a machine grant", async () => {
  const target = `https://${createId()}.example/unapproved`;
  await connection.db.insert(schema.oauthResources).values({
    id: createId(),
    identifier: target,
    name: "Unapproved",
    allowedScopes: ["proof:read"],
  });
  await connection.db.insert(schema.oauthClientResources).values({
    id: createId(),
    clientId,
    resourceId: target,
  });
  const response = await testAuth().handler(
    new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: target,
        scope: "proof:read",
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "unauthorized_client" });
});

test("machine capabilities bound default/explicit scopes and stop issuance when disabled, expired or removed", async () => {
  const target = `https://${createId()}.example/approved`;
  await connection.db.insert(schema.oauthResources).values({
    id: createId(),
    identifier: target,
    name: "Approved",
    allowedScopes: ["proof:read", "proof:write"],
  });
  await connection.db
    .insert(schema.oauthClientResources)
    .values({ id: createId(), clientId, resourceId: target });
  await connection.db
    .update(schema.oauthClients)
    .set({ clientCredentialsScopes: ["proof:read", "proof:write"] })
    .where(eq(schema.oauthClients.clientId, clientId));
  const capability = await approveMachineCapability(connection.db, {
    organizationId,
    clientId,
    resource: target,
    scopes: ["proof:read"],
  });
  const auth = testAuth();
  const mint = (scope?: string) =>
    auth.handler(
      new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource: target,
          ...(scope === undefined ? {} : { scope }),
        }),
      }),
    );
  const first = await mint();
  expect(first.status).toBe(200);
  const claims = decodeJwt((await first.json()).access_token);
  expect(claims.scope).toBe("proof:read");
  const [event] = await connection.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.targetId, String(claims.jti)));
  expect(event!.data).toMatchObject({
    decision: {
      allowed: true,
      requestedScopes: null,
      scopes: ["proof:read"],
      evidence: {
        policyVersion: 1,
        capabilities: [
          { id: capability.id, revision: 1, scopes: ["proof:read"] },
        ],
      },
    },
  });
  const tooBroad = await mint("proof:read proof:write");
  expect(tooBroad.status).toBe(400);
  expect(await tooBroad.json()).toMatchObject({ error: "invalid_scope" });
  for (const patch of [
    { status: "disabled" as const },
    { status: "active" as const, validFrom: new Date(Date.now() + 60_000) },
    { validFrom: null, validUntil: new Date(Date.now() - 60_000) },
  ]) {
    await connection.db
      .update(schema.organizationCapabilities)
      .set(patch)
      .where(eq(schema.organizationCapabilities.id, capability.id));
    const response = await mint("proof:read");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "unauthorized_client",
    });
  }
  await connection.db
    .update(schema.organizationCapabilities)
    .set({ validUntil: null })
    .where(eq(schema.organizationCapabilities.id, capability.id));
  expect((await mint("proof:read")).status).toBe(200);
  await connection.db
    .delete(schema.organizationCapabilities)
    .where(eq(schema.organizationCapabilities.id, capability.id));
  expect((await mint()).status).toBe(400);
  // A user grant on the same pair cannot substitute for the missing machine ceiling.
  await connection.db.insert(schema.organizationCapabilities).values({
    id: createId(),
    organizationId,
    clientId,
    resource: target,
    grantKind: "authorization_code",
    scopes: ["proof:read"],
  });
  expect((await mint()).status).toBe(400);
  await connection.db
    .update(schema.oauthClients)
    .set({ clientCredentialsScopes: ["proof:read"] })
    .where(eq(schema.oauthClients.clientId, clientId));
});
