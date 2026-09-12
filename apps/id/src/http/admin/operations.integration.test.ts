import { createDatabase } from "../../db/client.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
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
  },
  () => fixture,
);
async function read(
  path: string,
  kind: Parameters<AdminFixture["headers"]>[0],
) {
  return fixture.app.request(`/api/admin/v1${path}`, {
    headers: fixture.headers(kind),
  });
}
test("operation status exposes the receipt to platform audit authority", async () => {
  for (const [path, kind] of [
    [`/operations/${id}`, "platformReader"],
  ] as const) {
    const response = await read(path, kind);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id,
      name: "test.removed",
      outcome: "applied",
      statusCode: 200,
    });
    expect(Object.keys(body).sort()).toEqual([
      "committedAt",
      "id",
      "name",
      "outcome",
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

test("unknown operations return not_found and invalid UUIDs are rejected", async () => {
  for (const [path, kind] of [
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

test("operation audit reads require authority current at transaction entry", async () => {
  for (const path of [`/operations/${id}`]) {
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
  const response = await read(`/operations/${operationId}`, "platformReader");
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
