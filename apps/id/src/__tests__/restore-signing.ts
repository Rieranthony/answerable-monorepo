import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import {
  auditEvents,
  jwks,
  oauthClients,
  oauthClientResources,
  oauthResources,
} from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import { createId } from "../lib/id.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import { approveMachineCapability } from "./capabilities.ts";

/** Use the reachable machine flow, then independently verify signatures after restore. */
export async function prepareRestoredSigning(
  owner: Database,
  runtime: Database,
  environment: Environment,
  organizationId: string,
) {
  const clientId = `restore-signing-${createId()}`;
  const instanceId = createId();
  const secret = crypto.randomUUID();
  const resource = `https://restore.example.com/signing/${instanceId}`;
  const scope = "proof:read";
  await owner
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: resource,
      name: "Restore signing",
      organizationId,
      classification: "tenant_owned",
      allowedScopes: [scope],
      accessTokenTtl: 600,
    });
  await owner.insert(oauthClients).values({
    id: instanceId,
    clientId,
    organizationId,
    clientSecret: hashClientSecret(secret),
    name: "Restore signing",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "client_secret_basic",
    clientCredentialsScopes: [scope],
  });
  await owner
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await approveMachineCapability(owner, {
    organizationId,
    clientId,
    resource,
    scopes: [scope],
  });
  async function issue(database: Database, config: Environment) {
    return createApp({
      auth: createAuth(database, config),
      db: database,
      environment: config,
    }).request("/auth/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource,
        scope,
      }),
    });
  }
  const response = await issue(runtime, environment);
  assert.equal(response.status, 200);
  const original = ((await response.json()) as { access_token: string })
    .access_token;
  const keys = await owner.select().from(jwks).orderBy(jwks.id);
  const header = decodeProtectedHeader(original);
  const key = keys.find((row) => row.id === header.kid);
  assert.ok(key && header.alg);
  const publicKey = await importJWK(JSON.parse(key.publicKey), header.alg);
  async function verify(token: string) {
    const result = await jwtVerify(token, publicKey, {
      issuer: environment.betterAuthUrl,
      audience: resource,
      algorithms: [header.alg!],
    });
    assert.equal(result.protectedHeader.kid, key!.id);
    assert.equal(result.payload.client_instance, instanceId);
    assert.equal(result.payload.organization_id, organizationId);
    assert.equal(result.payload.subject_type, "client");
    assert.equal(result.payload.scope, scope);
  }
  await verify(original);
  return async (restoredOwner: Database, restoredRuntime: Database) => {
    const readKeys = () => restoredOwner.select().from(jwks).orderBy(jwks.id);
    const issued = () =>
      restoredOwner
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, organizationId),
            eq(auditEvents.action, "oauth.token.issued"),
          ),
        )
        .orderBy(auditEvents.id);
    assert.deepEqual(await readKeys(), keys);
    await verify(original);
    const before = await issued();
    const unavailable = await issue(restoredRuntime, {
      ...environment,
      betterAuthSecret: crypto.randomUUID() + crypto.randomUUID(),
    });
    assert.equal(unavailable.status, 500);
    assert.equal(
      ((await unavailable.json()) as { code: string }).code,
      "authentication_unavailable",
    );
    assert.deepEqual(await issued(), before);
    assert.deepEqual(await readKeys(), keys);
    const resumed = await issue(restoredRuntime, environment);
    assert.equal(resumed.status, 200);
    await verify(
      ((await resumed.json()) as { access_token: string }).access_token,
    );
    assert.equal((await issued()).length, before.length + 1);
    assert.deepEqual(await readKeys(), keys);
  };
}
