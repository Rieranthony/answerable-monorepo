import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { members } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const paths = () => [
  `/organizations/${fixture.tenant.organizationId}/sso-provider/test`,
  "/clients",
  `/clients/${fixture.platform.client.clientId}`,
  "/resources",
  `/resources/${encodeURIComponent(fixture.platform.adminResource)}`,
  "/organizations",
  "/entitlements",
];
test("fleet reads reject platform authority revoked after middleware", async () => {
  for (const path of paths()) {
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
      const response = await fixture.app.request(`/api/admin/v1${path}`, {
        headers: fixture.headers("platformReader"),
      });
      expect(response.status).toBe(403);
    } finally {
      fixture.db.transaction = original;
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
    expect(response.status).toBe(200);
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
  const original = fixture.db.transaction.bind(fixture.db);
  let activeTransactions = 0;
  const observedTransactions: number[] = [];
  fixture.db.transaction = (async (...args: Parameters<typeof original>) => {
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
    fixture.db.transaction = original;
    fetcher.mockRestore();
  }
});
