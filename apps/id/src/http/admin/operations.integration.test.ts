import { approveMachineCapability } from "../../__tests__/capabilities.ts";
import { createDatabase } from "../../db/client.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { platformWriteService } from "../../__tests__/platform-context.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import {
  adminOperations,
  members,
  organizations,
  auditEvents,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import {
  createClient as createClientImplementation,
  linkResource as linkResourceImplementation,
} from "../../services/clients.ts";
const createClient = platformWriteService(createClientImplementation);
const linkResource = platformWriteService(linkResourceImplementation);
import { systemActor } from "../../bootstrap.ts";
import { routes } from "./operations.ts";

let fixture: AdminFixture;
const id = createId();
beforeAll(async () => {
  fixture = await createAdminFixture();
  await fixture.db.execute(sql`truncate admin_operations cascade`);
  await fixture.db.insert(adminOperations).values({
    id,
    actorInstance: `user:${fixture.principals.tenantAdmin.userId}`,
    authorityScope: `tenant:${fixture.tenant.organizationId}`,
    name: "test.removed",
    keyDigest: "private-key-digest",
    fingerprint: "private-request-digest",
    outcome: "applied",
    statusCode: 200,
    resultReference: { type: "member", id: createId() },
  });
});
afterAll(async () => fixture?.close());
describeAdminRoutes(
  {
    getOperation: routes.getOperation,
    getOrganizationOperation: routes.getOrganizationOperation,
  },
  () => fixture,
);
const tenantPath = () =>
  `/organizations/${fixture.tenant.organizationId}/operations/${id}`;
async function read(
  path: string,
  kind: Parameters<AdminFixture["headers"]>[0],
) {
  return fixture.app.request(`/api/admin/v1${path}`, {
    headers: fixture.headers(kind),
  });
}
test("operation status exposes only the result reference to its actor or platform audit authority", async () => {
  for (const [path, kind] of [
    [tenantPath(), "tenantAdmin"],
    [tenantPath(), "platformReader"],
    [`/operations/${id}`, "platformReader"],
  ] as const) {
    const response = await read(path, kind);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id,
      name: "test.removed",
      outcome: "applied",
      replay: "reference",
      statusCode: 200,
    });
    expect(Object.keys(body).sort()).toEqual([
      "committedAt",
      "id",
      "name",
      "outcome",
      "replay",
      "replayExpiresAt",
      "resultReference",
      "statusCode",
    ]);
    // The referenced member never existed: status does not depend on a live target.
    expect(body.resultReference.type).toBe("member");
  }
  const machine = await read(`/operations/${id}`, {
    bearer: await fixture.mintMachineToken(["platform:read"]),
  });
  expect(machine.status).toBe(200);
});

test("foreign actors and tenant scopes are indistinguishable from missing operations", async () => {
  for (const [path, kind] of [
    [tenantPath(), "tenantReader"],
    [tenantPath(), "outsider"],
    [
      `/organizations/${fixture.outsider.organizationId}/operations/${id}`,
      "platformReader",
    ],
    [`/operations/${createId()}`, "platformReader"],
  ] as const) {
    const response = await read(path, kind);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  }
  expect((await read("/operations/not-a-uuid", "platformReader")).status).toBe(
    400,
  );
});

test("a revoked tenant membership cannot read its retained operation", async () => {
  await fixture.db
    .update(members)
    .set({ validUntil: sql`now() - interval '1 second'` })
    .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
  expect((await read(tenantPath(), "tenantAdmin")).status).toBe(404);
});

test("tenant machine status is bound to its authenticated client identity", async () => {
  const client = await createClient(fixture.db, systemActor("fixture"), {
    clientId: "operation-status-machine",
    name: "Status machine",
    organizationId: fixture.tenant.organizationId,
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: [],
    clientCredentialsScopes: ["org:read"],
  });
  await linkResource(
    fixture.db,
    systemActor("fixture"),
    client.clientId,
    fixture.platform.adminResource,
  );
  await approveMachineCapability(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    clientId: client.clientId,
    resource: fixture.platform.adminResource,
    scopes: ["org:read"],
  });
  const tokenResponse = await fixture.app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: fixture.platform.adminResource,
      scope: "org:read",
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const bearer = (await tokenResponse.json()).access_token;
  const operationId = createId();
  await fixture.db.insert(adminOperations).values({
    id: operationId,
    actorInstance: `client:${client.clientId}`,
    authorityScope: `tenant:${fixture.tenant.organizationId}`,
    name: "test.machine",
    keyDigest: "machine-key",
    fingerprint: "machine-input",
    outcome: "noop",
    statusCode: 204,
    resultReference: { type: "client", id: client.clientId },
  });
  const response = await read(
    `/organizations/${fixture.tenant.organizationId}/operations/${operationId}`,
    { bearer },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: "noop",
    statusCode: 204,
  });
  expect((await read(tenantPath(), { bearer })).status).toBe(404);
  const own = await read(`/me/operations/${operationId}`, { bearer });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ id: operationId, outcome: "noop" });
});

test("operation audit reads require authority current at transaction entry", async () => {
  for (const path of [tenantPath(), `/operations/${id}`]) {
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
      return original(...args);
    }) as typeof original);
    try {
      expect((await read(path, "platformReader")).status).toBe(403);
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
    }
  }
});

test("losing platform authority requires independent tenant SSO before own-receipt access", async () => {
  const { createEntitlement } =
    await import("../../__tests__/entitlement-queries.ts");
  const actor = fixture.principals.platformReader;
  const memberId = createId();
  await fixture.db.insert(members).values({
    id: memberId,
    organizationId: fixture.tenant.organizationId,
    userId: actor.userId,
  });
  await createEntitlement(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    memberId,
    resource: fixture.environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
  const ownId = createId();
  await fixture.db.insert(adminOperations).values({
    id: ownId,
    actorInstance: `user:${actor.userId}`,
    authorityScope: `tenant:${fixture.tenant.organizationId}`,
    name: "test.own",
    keyDigest: ownId,
    fingerprint: "private",
    outcome: "noop",
    statusCode: 204,
    resultReference: { type: "member", id: createId() },
  });
  try {
    for (const operationId of [id, ownId]) {
      const original = fixture.db.transaction.bind(fixture.db);
      fixture.db.transaction = afterBrokerRead(original, (async (
        ...args: Parameters<typeof original>
      ) => {
        fixture.db.transaction = original;
        await fixture.db
          .update(members)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(members.id, actor.memberId));
        return original(...args);
      }) as typeof original);
      try {
        const response = await read(
          `/organizations/${fixture.tenant.organizationId}/operations/${operationId}`,
          "platformReader",
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      } finally {
        fixture.db.transaction = original;
        await fixture.db
          .update(members)
          .set({ status: "active", revokedAt: null })
          .where(eq(members.id, actor.memberId));
      }
    }
    const { accounts } = await import("../../db/schema/index.ts");
    const { signInThroughIdp } = await import("../../__tests__/federation.ts");
    await fixture.db
      .insert(accounts)
      .values({
        id: createId(),
        userId: actor.userId,
        issuer: fixture.issuer.origin,
        providerId: "tenant",
        accountId: "receipt-bound-tenant",
      });
    fixture.issuer.enqueue({
      sub: "receipt-bound-tenant",
      email: "receipt@tenant.example.com",
      email_verified: true,
    });
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: "tenant",
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    expect(signedIn.location).toBe(`${fixture.trustedOrigin}/callback`);
    const cookie = signedIn.cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    for (const [operationId, expected] of [
      [id, 404],
      [ownId, 200],
    ] as const) {
      const response = await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/operations/${operationId}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status).toBe(expected);
    }
  } finally {
    await fixture.db.delete(members).where(eq(members.id, memberId));
  }
});

test("platform operation auditing survives tenant erasure", async () => {
  const { createOrganization } =
    await import("../../__tests__/organization-queries.ts");
  const { organizations } = await import("../../db/schema/index.ts");
  const org = await createOrganization(fixture.db, {
    slug: "erased-receipts",
    name: "Erased receipts",
  });
  const operationId = createId();
  await fixture.db.insert(adminOperations).values({
    id: operationId,
    actorInstance: "system:root",
    authorityScope: `tenant:${org.id}`,
    name: "test.erased",
    keyDigest: operationId,
    fingerprint: "private",
    outcome: "applied",
    statusCode: 204,
    resultReference: { type: "organization", id: org.id },
  });
  await fixture.db.delete(organizations).where(eq(organizations.id, org.id));
  const response = await read(
    `/organizations/${org.id}/operations/${operationId}`,
    "platformReader",
  );
  expect(response.status).toBe(200);
  expect((await response.json()).resultReference).toEqual({
    type: "organization",
    id: org.id,
  });
});

test("a blocked administrative write returns retryable 503 without retaining an operation", async () => {
  const organizationId = createId();
  await fixture.db.insert(organizations).values({
    id: organizationId,
    slug: `lock-${organizationId}`,
    name: "Lock test",
  });
  const holderConnection = createDatabase(fixture.environment);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holder = holderConnection.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${organizationId} for update`,
    );
    entered();
    await barrier;
  });
  await started;
  const headers = fixture.headers("platformAdmin");
  headers.set("x-request-id", createId());
  const path = `/api/admin/v1/organizations/${organizationId}/disable`;
  const before = await fixture.db.select().from(adminOperations);
  try {
    const response = await fixture.app.request(path, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Operation-Id")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "database_busy",
      retryable: true,
    });
    expect(await fixture.db.select().from(adminOperations)).toHaveLength(
      before.length,
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.requestId, headers.get("x-request-id")!)),
    ).toHaveLength(0);
  } finally {
    release();
    await holder;
    await holderConnection.close();
  }
  const retry = await fixture.app.request(path, { method: "POST", headers });
  expect(retry.status).toBe(200);
  expect(retry.headers.get("Idempotency-Replayed")).toBe("false");
  const replay = await fixture.app.request(path, { method: "POST", headers });
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(replay.headers.get("Operation-Id")).toBe(
    retry.headers.get("Operation-Id"),
  );
});
