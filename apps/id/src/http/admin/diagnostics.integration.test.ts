import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { createId } from "../../lib/id.ts";
import { routes, signInDiagnosisSchema } from "./diagnostics.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
function request(
  email: string | null,
  kind: Parameters<AdminFixture["headers"]>[0] = "tenantUsersOnly",
  id?: string,
) {
  const query = email === null ? "" : `?${new URLSearchParams({ email })}`;
  return fixture.app.request(
    `/api/admin/v1/organizations/${id ?? fixture.tenant.organizationId}/sign-in-diagnosis${query}`,
    { headers: fixture.headers(kind) },
  );
}
test("tenantUsersOnly diagnoses members, unknown emails and disabled users", async () => {
  for (const [email, code, effective] of [
    ["TENANTADMIN@TENANT.EXAMPLE.COM", "authentication_required", true],
    ["unknown@tenant.example.com", "authentication_required", null],
    ["expiredmember@tenant.example.com", "authentication_required", false],
    ["disableduser@tenant.example.com", "user_disabled", true],
  ] as const) {
    const response = await request(email);
    expect(response.status).toBe(200);
    const result = signInDiagnosisSchema.parse(await response.json());
    expect(result.email).toBe(email.toLowerCase());
    expect(result.verdict.code).toBe(code);
    expect(result.membership?.effective ?? null).toBe(effective);
  }
});
test("platform readers, admins and machine tokens diagnose tenant users", async () => {
  for (const kind of [
    "platformAdmin",
    "platformReader",
    { bearer: await fixture.mintMachineToken(["platform:read"]) },
  ] as const) {
    const response = await request("tenantadmin@tenant.example.com", kind);
    expect(response.status).toBe(200);
    expect(
      signInDiagnosisSchema.parse(await response.json()).verdict.code,
    ).toBe("authentication_required");
  }
});
test("validates required email and organisation id", async () => {
  for (const email of [null, "", "invalid"])
    expect((await request(email)).status).toBe(400);
  expect(
    (await request("person@example.com", "platformAdmin", "bad-id")).status,
  ).toBe(400);
  expect(
    (await request("person@example.com", "platformAdmin", createId())).status,
  ).toBe(404);
});

test("tenant diagnosis does not expose foreign users, accounts or routing identities", async () => {
  const { users } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const [foreign] = await fixture.db
    .select()
    .from(users)
    .where(eq(users.id, fixture.principals.outsider.userId));
  const result = await (await request(foreign!.email)).json();
  expect(result.user).toBeNull();
  expect(result.membership).toBeNull();
  expect(result.routing.routesTo).toBeNull();
  expect(result).not.toHaveProperty("accounts");
  const unknown = await (
    await request(`missing@${foreign!.email.split("@")[1]}`)
  ).json();
  expect({ ...result, email: null }).toEqual({ ...unknown, email: null });
});

test("diagnosis rechecks tenant authority after middleware and does not broaden staff projections", async () => {
  const { members } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const email = "tenantadmin@tenant.example.com";
  const accepted = await request(email);
  expect(accepted.headers.get("Cache-Control")).toBe("no-store");
  const body = await accepted.json();
  expect(body).not.toHaveProperty("accounts");
  expect(body.user).not.toHaveProperty("retiredEmail");
  expect(await (await request(email, "platformReader")).json()).toEqual(body);
  const original = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = afterBrokerRead(original, (async (
    ...args: Parameters<typeof original>
  ) => {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, fixture.principals.tenantUsersOnly.memberId));
    return original(...args);
  }) as typeof original);
  try {
    const denied = await request(email);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, fixture.principals.tenantUsersOnly.memberId));
  }
});
