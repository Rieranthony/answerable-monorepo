import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./diagnostics.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
const signInDiagnosisSchema = responseSchema("diagnoseSignIn", 200);
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
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

test("tenant diagnosis does not broaden staff projections", async () => {
  const email = "tenantadmin@tenant.example.com";
  const accepted = await request(email);
  expect(accepted.headers.get("Cache-Control")).toBe("no-store");
  const body = await accepted.json();
  expect(body).not.toHaveProperty("accounts");
  expect(body.user).not.toHaveProperty("retiredEmail");
  expect(await (await request(email, "platformReader")).json()).toEqual(body);
});
