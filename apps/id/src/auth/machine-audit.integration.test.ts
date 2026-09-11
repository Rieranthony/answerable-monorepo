import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getCurrentAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import type { machineOAuthProvider } from "./machine-provider.ts";
import { decodeJwt } from "jose";
import { recordMachineIssuance } from "./machine-audit.ts";
import { createId } from "../lib/id.ts";
import { createAuth } from "../auth.ts";
import { createApp } from "../app.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import {
  auditEvents,
  auditEventSubjects,
  oauthClients,
  oauthResources,
  organizationCapabilities,
  verifications,
} from "../db/schema/index.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createResource } from "../__tests__/resource-queries.ts";
import * as clientsImplementation from "../services/clients.ts";
const clients = {
  ...clientsImplementation,
  createClient: platformWriteService(clientsImplementation.createClient),
  linkResource: platformWriteService(clientsImplementation.linkResource),
};

let connection: DatabaseConnection;
const environment = testEnvironment();
const actor = {
  actorType: "system" as const,
  actorId: "issuance-proof",
  requestId: "setup",
};
let tenantId: string;
let client: Awaited<ReturnType<typeof clients.createClient>>;
let app: ReturnType<typeof createApp>;
let auth: ReturnType<typeof createAuth>;
beforeAll(() => {
  connection = createDatabase(environment);
});
afterAll(async () => connection.close());
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate audit_events, organizations, oauth_clients, oauth_resources cascade`,
  );
  tenantId = (
    await createOrganization(connection.db, {
      slug: "issuance",
      name: "Issuance",
    })
  ).id;
  await createResource(connection.db, {
    identifier: environment.adminResourceIdentifier,
    name: "Admin",
    allowedScopes: ["org:read"],
    accessTokenTtl: 120,
  });
  client = await clients.createClient(connection.db, actor, {
    clientId: "issuance-proof",
    name: "Issuance",
    organizationId: tenantId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    clientCredentialsScopes: ["org:read"],
  });
  await clients.linkResource(
    connection.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  await approveMachineCapability(connection.db, {
    organizationId: tenantId,
    clientId: client.clientId,
    resource: environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
  auth = createAuth(connection.db, environment);
  app = createApp({
    db: connection.db,
    auth,
    environment,
  });
});
function mint(
  requestId?: string,
  input: { scope?: string; secret?: string; resource?: string } = {},
) {
  const headers = new Headers({
    Authorization: `Basic ${Buffer.from(`${client.clientId}:${input.secret ?? client.clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (requestId) headers.set("x-request-id", requestId);
  return app.request("/auth/oauth2/token", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: input.scope ?? "org:read",
      resource: input.resource ?? environment.adminResourceIdentifier,
      metadata: JSON.stringify({
        organization_id: createId(),
        client_instance: createId(),
        note: "untrusted-marker",
      }),
    }),
  });
}
function issuedEvents() {
  return connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "oauth.token.issued"));
}

test("successful machine issuance commits one attributed, secret-free audit fact", async () => {
  const response = await mint();
  expect(response.status).toBe(200);
  const token = (await response.json()).access_token;
  const claims = decodeJwt(token);
  const [currentClient] = await connection.db.select().from(oauthClients);
  const [resource] = await connection.db.select().from(oauthResources);
  const events = await issuedEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorType: "client",
    actorId: client.clientId,
    organizationId: tenantId,
    targetType: "access_token",
    targetId: claims.jti,
    outcome: "success",
    requestId: response.headers.get("x-request-id"),
    operationId: null,
    schemaVersion: 2,
    data: {
      decision: {
        allowed: true,
        reason: "approved",
        grantType: "client_credentials",
        subjectType: "client",
        organization: { id: tenantId, authorizationVersion: 1 },
        client: {
          id: currentClient!.id,
          clientId: client.clientId,
          revision: currentClient!.revision,
          authorizationVersion: 1,
          scopeCeiling: ["org:read"],
        },
        resource: {
          id: resource!.id,
          identifier: resource!.identifier,
          revision: resource!.revision,
          scopeCeiling: ["org:read"],
        },
        requestedScopes: ["org:read"],
        scopes: ["org:read"],
        evidence: {
          policyVersion: 1,
          capabilities: [
            { grantKind: "client_credentials", scopes: ["org:read"] },
          ],
        },
      },
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    },
  });
  const encoded = JSON.stringify(events);
  expect(encoded).not.toContain(token);
  expect(encoded).not.toContain(client.clientSecret!);
  expect(encoded).not.toContain("untrusted-marker");
  expect(
    await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, events[0]!.id)),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entityType: "client",
        entityId: client.clientId,
        relationship: "actor",
        organizationId: tenantId,
      }),
      expect.objectContaining({
        entityType: "access_token",
        entityId: claims.jti,
        relationship: "target",
      }),
    ]),
  );
});

test("audit failure prevents token release; a new request succeeds after recovery", async () => {
  const marker = createId();
  const provider = auth.options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  ) as ReturnType<typeof machineOAuthProvider>;
  provider.options.extensions!.push({
    claims: {
      accessToken: async ({ ctx }) => {
        await (
          await getCurrentAdapter(ctx.context.adapter)
        ).create({
          model: "verification",
          data: {
            identifier: marker,
            value: "issuance transaction",
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        return {};
      },
    },
  });
  await connection.db.execute(
    sql`create function reject_machine_audit_test() returns trigger language plpgsql as $$ begin if NEW.action = 'oauth.token.issued' then raise exception 'audit storage unavailable'; end if; return NEW; end; $$`,
  );
  await connection.db.execute(
    sql`create trigger reject_machine_audit_test before insert on audit_events for each row execute function reject_machine_audit_test()`,
  );
  try {
    const response = await mint("audit-failure");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    const body = await response.json();
    expect(body).toMatchObject({ error: "temporarily_unavailable" });
    expect(body).not.toHaveProperty("access_token");
    expect(await rejectedEvents()).toMatchObject([
      {
        outcome: "failure",
        reason: "temporarily_unavailable",
        data: {
          stage: "issuance",
          authenticatedClient: { organizationId: tenantId },
        },
      },
    ]);
    expect(await issuedEvents()).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, marker)),
    ).toHaveLength(0);
  } finally {
    await connection.db.execute(
      sql`drop trigger reject_machine_audit_test on audit_events`,
    );
    await connection.db.execute(sql`drop function reject_machine_audit_test()`);
  }
  expect((await mint("audit-failure")).status).toBe(200);
  expect(
    await connection.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, marker)),
  ).toHaveLength(1);
  expect(await issuedEvents()).toHaveLength(1);
});

test("repeated correlation IDs describe distinct OAuth issuances, not operation replay", async () => {
  const first = await mint("same-correlation");
  const second = await mint("same-correlation");
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const events = await issuedEvents();
  expect(events).toHaveLength(2);
  expect(new Set(events.map((event) => event.targetId)).size).toBe(2);
  expect(
    events.every(
      (event) =>
        event.operationId === null && event.requestId === "same-correlation",
    ),
  ).toBe(true);
});

test("audit evidence rejects mismatched client, audience and scope decisions", async () => {
  const response = await mint();
  const token = (await response.json()).access_token;
  const decision = (await issuedEvents())[0]!.data!.decision as Parameters<
    typeof recordMachineIssuance
  >[1]["decision"];
  for (const changed of [
    { ...decision, client: { ...decision.client, clientId: "another-client" } },
    {
      ...decision,
      resource: {
        ...decision.resource,
        identifier: "https://another-resource.example",
      },
    },
    { ...decision, scopes: ["org:read", "org:write"] },
    { ...decision, scopes: ["org:write"] },
  ])
    await expect(
      connection.db.transaction((tx) =>
        recordMachineIssuance(tx, { token, decision: changed }),
      ),
    ).rejects.toThrow("authenticated policy decision");
  expect(await issuedEvents()).toHaveLength(1);
});

for (const field of [
  "organization_id",
  "client_instance",
  "authorization_version",
  "organization_authorization_version",
  "scope",
] as const) {
  test(`machine issuance rejects ${field} diverging from its policy decision`, async () => {
    const marker = createId();
    const provider = auth.options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    ) as ReturnType<typeof machineOAuthProvider>;
    provider.options.extensions!.unshift({
      claims: {
        accessToken: async ({ ctx, scopes }) => {
          await (
            await getCurrentAdapter(ctx.context.adapter)
          ).create({
            model: "verification",
            data: {
              identifier: marker,
              value: "must roll back",
              expiresAt: new Date(Date.now() + 60000),
            },
          });
          if (field === "scope") {
            scopes.push("org:write");
            return {};
          }
          return { [field]: field.endsWith("version") ? 999 : createId() };
        },
      },
    });
    const response = await mint();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("access_token");
    expect(await rejectedEvents()).toMatchObject([
      {
        outcome: "failure",
        reason: "issuance_failed",
        data: {
          stage: "issuance",
          authenticatedClient: { clientId: client.clientId },
          decision: {
            allowed: true,
            reason: "approved",
            scopes: ["org:read"],
            organization: { id: tenantId },
          },
        },
      },
    ]);
    expect(await issuedEvents()).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, marker)),
    ).toHaveLength(0);
    provider.options.extensions!.shift();
    expect((await mint()).status).toBe(200);
    expect(await issuedEvents()).toHaveLength(1);
  });
}

test("versioned machine decision history preserves legacy events and the evaluated snapshot", async () => {
  const { recordAuditEvent } = await import("../db/queries/audit.ts");
  const legacyData = {
    grantType: "client_credentials",
    grantedScopes: ["org:read"],
    policy: { policyVersion: 1, capabilityId: createId() },
  };
  const legacy = await recordAuditEvent(connection.db, {
    actorType: "client",
    actorId: client.clientId,
    organizationId: tenantId,
    action: "oauth.token.issued",
    targetType: "access_token",
    targetId: createId(),
    outcome: "success",
    schemaVersion: 1,
    data: legacyData,
  });
  const minted = await mint();
  expect(minted.status).toBe(200);
  const token = (await minted.json()).access_token;
  const response = await app.request(
    `/api/admin/v1/organizations/${tenantId}/audit-events?action=oauth.token.issued`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  const events = (await response.json()).items;
  expect(events).toHaveLength(2);
  expect(
    events.find((event: { id: string }) => event.id === legacy.id),
  ).toMatchObject({ schemaVersion: 1, data: legacyData });
  const current = events.find(
    (event: { schemaVersion: number }) => event.schemaVersion === 2,
  );
  expect(current.data.decision).toMatchObject({
    allowed: true,
    reason: "approved",
    scopes: ["org:read"],
    organization: { id: tenantId },
    requestedScopes: ["org:read"],
  });
  await connection.db
    .update(oauthClients)
    .set({ clientCredentialsScopes: ["org:write"] })
    .where(eq(oauthClients.clientId, client.clientId));
  await connection.db
    .update(oauthResources)
    .set({ allowedScopes: ["org:write"] })
    .where(eq(oauthResources.identifier, environment.adminResourceIdentifier));
  const [retained] = await connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.id, current.id));
  expect(retained!.data).toEqual(current.data);
  expect(
    (await issuedEvents()).find((event) => event.id === legacy.id)!.data,
  ).toEqual(legacyData);
});

function rejectedEvents() {
  return connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "oauth.token.rejected"));
}

test("verified client denial is durable and does not attribute a claimed client", async () => {
  const [registered] = await connection.db.select().from(oauthClients);
  const denied = await mint("denial-proof", {
    scope: "untrusted-secret-scope",
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "invalid_scope" });
  const events = await rejectedEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    schemaVersion: 2,
    actorType: "client",
    actorId: client.clientId,
    organizationId: tenantId,
    targetType: "oauth_request",
    targetId: null,
    outcome: "denied",
    reason: "invalid_scope",
    requestId: "denial-proof",
    data: {
      grantType: "client_credentials",
      stage: "authorization",
      authenticatedClient: {
        id: registered!.id,
        clientId: client.clientId,
        organizationId: tenantId,
      },
      decision: {
        allowed: false,
        reason: "invalid_scope",
        organization: { id: tenantId },
        client: { id: registered!.id, scopeCeiling: ["org:read"] },
        resource: { identifier: environment.adminResourceIdentifier },
        scopes: [],
        evidence: {
          policyVersion: 1,
          capabilities: [
            { grantKind: "client_credentials", scopes: ["org:read"] },
          ],
        },
      },
    },
  });
  const encoded = JSON.stringify(events);
  for (const secret of [
    client.clientSecret!,
    "untrusted-secret-scope",
    "untrusted-marker",
  ])
    expect(encoded).not.toContain(secret);
  const forged = await mint("forged-client", { secret: "wrong-credential" });
  expect(forged.status).toBeGreaterThanOrEqual(400);
  const attempts = await rejectedEvents();
  expect(attempts).toHaveLength(2);
  const unauthenticated = attempts.find(
    (event) => event.requestId === "forged-client",
  )!;
  expect(unauthenticated).toMatchObject({
    schemaVersion: 3,
    actorType: "system",
    actorId: "oauth-client-authentication",
    organizationId: null,
    outcome: "denied",
    reason: "invalid_client",
    data: {
      stage: "authentication",
      authenticatedClient: null,
      decision: null,
    },
  });
  for (const secret of [
    client.clientId,
    tenantId,
    "wrong-credential",
    client.clientSecret!,
  ])
    expect(JSON.stringify(unauthenticated)).not.toContain(secret);
  expect(await issuedEvents()).toHaveLength(0);
});

test("rejection audit failure keeps the original denial and emits only a safe operational signal", async () => {
  await connection.db.execute(
    sql`create function reject_denial_audit_test() returns trigger language plpgsql as $$ begin if NEW.action = 'oauth.token.rejected' then raise exception 'private-audit-error'; end if; return NEW; end; $$`,
  );
  await connection.db.execute(
    sql`create trigger reject_denial_audit_test before insert on audit_events for each row execute function reject_denial_audit_test()`,
  );
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await mint("audit-denial-outage", {
      scope: "untrusted-secret-scope",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
    const unauthenticated = await mint("unauthenticated-audit-outage", {
      secret: "wrong-credential",
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: "invalid_client",
    });
    expect(await rejectedEvents()).toHaveLength(0);
    expect(await issuedEvents()).toHaveLength(0);
    expect(log.mock.calls).toContainEqual([
      "[id] auth",
      JSON.stringify({
        level: "error",
        event: "token_rejection_audit_unavailable",
      }),
    ]);
    for (const secret of [
      client.clientSecret!,
      "private-audit-error",
      "wrong-credential",
      "untrusted-secret-scope",
    ])
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  } finally {
    log.mockRestore();
    await connection.db.execute(
      sql`drop trigger reject_denial_audit_test on audit_events`,
    );
    await connection.db.execute(sql`drop function reject_denial_audit_test()`);
  }
  expect(
    (await mint("audit-denial-outage", { scope: "org:write" })).status,
  ).toBe(400);
  expect(await rejectedEvents()).toHaveLength(1);
});

test("tenant denial history exposes no foreign resource configuration", async () => {
  const reader = (await (await mint()).json()).access_token;
  expect(
    (await mint("unattributed-attempt", { secret: "wrong-credential" })).status,
  ).toBe(401);
  const foreign = await createOrganization(connection.db, {
    slug: "foreign-audit",
    name: "Foreign",
  });
  const resource = await createResource(connection.db, {
    identifier: "https://foreign-audit.example/private",
    name: "private-resource-name",
    classification: "tenant_owned",
    organizationId: foreign.id,
    allowedScopes: ["private:scope"],
  });
  const denied = await mint("foreign-target", {
    resource: resource.identifier,
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "invalid_target" });
  const response = await app.request(
    `/api/admin/v1/organizations/${tenantId}/audit-events?action=oauth.token.rejected`,
    {
      headers: { Authorization: `Bearer ${reader}` },
    },
  );
  expect(response.status).toBe(200);
  const events = (await response.json()).items;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    organizationId: tenantId,
    reason: "invalid_target",
    outcome: "denied",
    data: { decision: null },
  });
  for (const privateValue of [
    foreign.id,
    resource.id,
    resource.identifier,
    "private-resource-name",
    "private:scope",
  ])
    expect(JSON.stringify(events)).not.toContain(privateValue);
  const foreignEvents = await connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, foreign.id));
  expect(
    foreignEvents.some((event) => event.action === "oauth.token.rejected"),
  ).toBe(false);
});

test("client authentication storage failure is unattributed and excludes exception details", async () => {
  const adapter = (await auth.$context).adapter;
  const lookup = spyOn(adapter, "findOne").mockRejectedValue(
    new Error("private-authentication-storage-detail"),
  );
  try {
    const response = await mint("authentication-storage-failure");
    expect(response.status).toBe(500);
    const events = await rejectedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 3,
      actorType: "system",
      actorId: "oauth-client-authentication",
      organizationId: null,
      outcome: "failure",
      reason: "authentication_failed",
      data: {
        stage: "authentication",
        authenticatedClient: null,
        decision: null,
      },
    });
    for (const value of [
      client.clientId,
      tenantId,
      client.clientSecret!,
      "private-authentication-storage-detail",
    ])
      expect(JSON.stringify(events)).not.toContain(value);
    expect(await issuedEvents()).toHaveLength(0);
  } finally {
    lookup.mockRestore();
  }
});

test("restricted runtime records failed authentication without a claimed-client subject", async () => {
  const role = `id_test_auth_attempt_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(connection.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await connection.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = role;
  url.password = password;
  const settings = { ...environment, databaseUrl: url.toString() };
  const runtime = createDatabase(settings);
  try {
    app = createApp({
      db: runtime.db,
      auth: createAuth(runtime.db, settings),
      environment: settings,
    });
    expect(
      (await mint("restricted-auth-denial", { secret: "wrong-credential" }))
        .status,
    ).toBe(401);
    const [event] = await rejectedEvents();
    expect(event).toMatchObject({
      schemaVersion: 3,
      organizationId: null,
      outcome: "denied",
    });
    const subjects = await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event!.id));
    expect(
      subjects.some(
        (subject) =>
          subject.entityType === "client" ||
          subject.entityType === "organization",
      ),
    ).toBe(false);
    expect(JSON.stringify(subjects)).not.toContain(client.clientId);
    expect(await issuedEvents()).toHaveLength(0);
  } finally {
    await runtime.close();
    await connection.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await connection.db.execute(sql`drop role ${sql.identifier(role)}`);
  }
});

test("malformed targets and missing capabilities retain distinct rejection stages", async () => {
  const response = await app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
  expect(await rejectedEvents()).toMatchObject([
    {
      schemaVersion: 2,
      reason: "invalid_target",
      data: { stage: "request", decision: null },
    },
  ]);
  await connection.db.delete(organizationCapabilities);
  const denied = await mint("no-capability");
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "unauthorized_client" });
  const events = await rejectedEvents();
  expect(events).toHaveLength(2);
  expect(
    events.find((event) => event.requestId === "no-capability"),
  ).toMatchObject({
    reason: "unauthorized_client",
    data: {
      stage: "authorization",
      decision: {
        allowed: false,
        reason: "unauthorized_client",
        evidence: { policyVersion: 1, capabilities: [] },
      },
    },
  });
  expect(await issuedEvents()).toHaveLength(0);
});

test("pre-evaluation scope refusal records no invented policy decision", async () => {
  const denied = await mint("identity-scope-denial", {
    scope: "openid private-untrusted-value",
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "invalid_scope" });
  const events = await rejectedEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    schemaVersion: 2,
    reason: "invalid_scope",
    data: { stage: "authorization", decision: null },
  });
  expect(JSON.stringify(events)).not.toContain("private-untrusted-value");
  expect(await issuedEvents()).toHaveLength(0);
});

test("versioned denial history keeps the evaluated ceilings after policy changes", async () => {
  const { recordAuditEvent } = await import("../db/queries/audit.ts");
  const reader = (await (await mint()).json()).access_token;
  const legacyData = {
    grantType: "client_credentials",
    stage: "authorization",
  };
  const legacy = await recordAuditEvent(connection.db, {
    actorType: "client",
    actorId: client.clientId,
    organizationId: tenantId,
    action: "oauth.token.rejected",
    targetType: "oauth_request",
    outcome: "denied",
    reason: "invalid_scope",
    schemaVersion: 1,
    data: legacyData,
  });
  const [capability] = await connection.db
    .select()
    .from(organizationCapabilities);
  const [registered] = await connection.db.select().from(oauthClients);
  const [resource] = await connection.db.select().from(oauthResources);
  expect((await mint("ceiling-denial", { scope: "org:write" })).status).toBe(
    400,
  );
  const captured = (await rejectedEvents()).find(
    (event) => event.requestId === "ceiling-denial",
  )!;
  expect(captured.data!.decision).toMatchObject({
    allowed: false,
    reason: "invalid_scope",
    client: {
      id: registered!.id,
      revision: registered!.revision,
      scopeCeiling: ["org:read"],
    },
    resource: {
      id: resource!.id,
      revision: resource!.revision,
      scopeCeiling: ["org:read"],
    },
    evidence: {
      evaluatedAt: expect.any(String),
      capabilities: [
        {
          id: capability!.id,
          revision: capability!.revision,
          scopes: ["org:read"],
        },
      ],
    },
  });
  expect(captured.data!.decision).not.toHaveProperty("requestedScopes");
  // Change policy while retaining the reader's org:read capability.
  await connection.db
    .update(organizationCapabilities)
    .set({ scopes: ["org:read", "org:write"] });
  await connection.db
    .update(oauthClients)
    .set({ clientCredentialsScopes: ["org:read", "org:write"] });
  await connection.db
    .update(oauthResources)
    .set({ allowedScopes: ["org:read", "org:write"] });
  const response = await app.request(
    `/api/admin/v1/organizations/${tenantId}/audit-events?action=oauth.token.rejected`,
    { headers: { Authorization: `Bearer ${reader}` } },
  );
  expect(response.status).toBe(200);
  const events = (await response.json()).items;
  expect(events).toHaveLength(2);
  expect(
    events.find((event: { id: string }) => event.id === captured.id),
  ).toMatchObject({
    schemaVersion: 2,
    data: captured.data,
  });
  expect(
    events.find((event: { id: string }) => event.id === legacy.id),
  ).toMatchObject({
    schemaVersion: 1,
    data: legacyData,
  });
  expect(
    (await mint("ceiling-now-approved", { scope: "org:write" })).status,
  ).toBe(200);
});

test("extension-specific denial cannot copy arbitrary error data into audit history", async () => {
  const privateReason = "fixture-private-provider-reason";
  const provider = auth.options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  ) as ReturnType<typeof machineOAuthProvider>;
  provider.options.extensions!.push({
    claims: {
      accessToken: () => {
        throw new APIError("FORBIDDEN", {
          error: privateReason,
          error_description: "private-provider-details",
        });
      },
    },
  });
  const response = await mint();
  expect(response.status).toBe(403);
  const events = await rejectedEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    outcome: "denied",
    reason: "request_rejected",
    data: {
      stage: "issuance",
      decision: {
        allowed: true,
        reason: "approved",
        organization: { id: tenantId },
        scopes: ["org:read"],
      },
    },
  });
  expect(JSON.stringify(events)).not.toContain(privateReason);
  expect(JSON.stringify(events)).not.toContain("private-provider-details");
  expect(await issuedEvents()).toHaveLength(0);
});
