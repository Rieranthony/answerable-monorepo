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
    ["TENANTADMIN@TENANT.EXAMPLE.COM", "would_sign_in", true],
    ["unknown@tenant.example.com", "new_user_would_be_created", null],
    ["expiredmember@tenant.example.com", "would_sign_in", false],
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
    ).toBe("would_sign_in");
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
