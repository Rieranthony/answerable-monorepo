import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { adminOperations, members } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
const operationId = createId();
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
  await fixture.db.insert(adminOperations).values({
    id: operationId,
    actorInstance: `user:${fixture.principals.platformAdmin.userId}`,
    authorityScope: "platform",
    name: "test.context",
    keyDigest: "context-key-digest",
    fingerprint: "context-fingerprint",
    outcome: "applied",
    statusCode: 200,
    resultReference: { type: "organization", id: createId() },
  });
});
afterAll(async () => fixture?.close());
const paths = () => {
  const user = fixture.principals.tenantReader.userId;
  return [
    `/organizations/${fixture.tenant.organizationId}/sso-provider/test`,
    "/clients",
    `/clients/${fixture.platform.client.clientId}`,
    "/resources",
    `/resources/${encodeURIComponent(fixture.platform.adminResource)}`,
    "/organizations",
    "/entitlements",
    "/audit-events",
    `/operations/${operationId}`,
    "/users",
    `/users/${user}`,
    `/users/${user}/sessions`,
    `/users/${user}/audit-events`,
  ];
};
test("fleet reads reject platform authority revoked after middleware", async () => {
  for (const path of paths()) {
    const original = fixture.appDb.transaction.bind(fixture.appDb);
    fixture.appDb.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
      return original(...args);
    }) as typeof original);
    try {
      const response = await fixture.app.request(`/api/admin/v1${path}`, {
        headers: fixture.headers("platformReader"),
      });
      expect(response.status, path).toBe(403);
    } finally {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
    }
  }
});

test("fleet responses prohibit caching", async () => {
  for (const path of paths()) {
    const response = await fixture.app.request(`/api/admin/v1${path}`, {
      headers: fixture.headers("platformReader"),
    });
    expect(response.status, path).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("SSO probe receives only endpoints and runs after the read transaction closes", async () => {
  const { inPlatformRead } =
    await import("../../__tests__/platform-context.ts");
  const { getSsoTestConfiguration } =
    await import("../../services/sso-test.ts");
  const snapshot = await inPlatformRead(fixture.db, (context) =>
    getSsoTestConfiguration(context, fixture.tenant.organizationId),
  );
  expect(Object.keys(snapshot).sort()).toEqual(["discoveryEndpoint", "issuer"]);
  const original = fixture.appDb.transaction.bind(fixture.appDb);
  let activeTransactions = 0;
  const observedTransactions: number[] = [];
  fixture.appDb.transaction = (async (...args: Parameters<typeof original>) => {
    activeTransactions++;
    try {
      return await original(...args);
    } finally {
      activeTransactions--;
    }
  }) as typeof original;
  const originalFetch = globalThis.fetch;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    url: Parameters<typeof fetch>[0],
    options?: RequestInit,
  ) => {
    observedTransactions.push(activeTransactions);
    return originalFetch(url, options);
  }) as typeof fetch);
  try {
    const response = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/sso-provider/test`,
      {
        headers: fixture.headers("platformReader"),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).problems).toEqual([]);
    expect(observedTransactions).toEqual([0, 0]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    fixture.appDb.transaction = original;
    fetcher.mockRestore();
  }
});
