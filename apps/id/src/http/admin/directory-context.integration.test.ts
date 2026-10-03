import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { createEntitlement } from "../../__tests__/entitlement-queries.ts";
import { addGroupMember, createGroup } from "../../__tests__/group-queries.ts";
import { createResource } from "../../__tests__/resource-queries.ts";
import { members } from "../../db/schema/index.ts";
let fixture: AdminFixture;
let groupId: string;
let entitlementId: string;
const resource = "https://directory-context.example";
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
  const organizationId = fixture.tenant.organizationId;
  await createResource(fixture.db, {
    identifier: resource,
    name: "Context",
    allowedScopes: ["read"],
  });
  const group = await createGroup(fixture.db, {
    organizationId,
    slug: "context-test",
    name: "Context",
  });
  groupId = group.id;
  await addGroupMember(fixture.db, {
    organizationId,
    groupId,
    memberId: fixture.principals.tenantReader.memberId,
  });
  const grant = await createEntitlement(fixture.db, {
    organizationId,
    groupId,
    resource: fixture.environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
  entitlementId = grant.id;
});
afterAll(async () => fixture?.close());
test("every tenant read route rechecks membership inside its read transaction", async () => {
  const base = `/api/admin/v1/organizations/${fixture.tenant.organizationId}`;
  const reader = fixture.principals.tenantReader.memberId;
  const paths: [string, "tenantReader" | "tenantUsersOnly"][] = [
    ["", "tenantReader"],
    ["/sso-provider", "tenantReader"],
    ["/groups", "tenantReader"],
    [`/groups/${groupId}`, "tenantReader"],
    [`/groups/${groupId}/members`, "tenantReader"],
    [`/groups/${groupId}/members/${reader}`, "tenantReader"],
    ["/domains", "tenantReader"],
    ["/entitlements", "tenantReader"],
    [`/entitlements/${entitlementId}`, "tenantReader"],
    ["/audit-events", "tenantReader"],
    [`/access?resource=${encodeURIComponent(resource)}`, "tenantReader"],
    ["/members", "tenantReader"],
    [`/members/${reader}`, "tenantReader"],
    [`/members/${reader}/configuration`, "tenantUsersOnly"],
    [`/members/${reader}/access`, "tenantUsersOnly"],
    [
      "/sign-in-diagnosis?email=tenantadmin%40tenant.example.com",
      "tenantUsersOnly",
    ],
  ];
  for (const [suffix, kind] of paths) {
    const actor = fixture.principals[kind];
    const headers = fixture.headers(kind);
    const send = () => fixture.app.request(base + suffix, { headers });
    const accepted = await send();
    expect(accepted.status, suffix).toBe(200);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    const original = fixture.appDb.transaction.bind(fixture.appDb);
    fixture.appDb.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, actor.memberId));
      return original(...args);
    }) as typeof original);
    try {
      const denied = await send();
      expect(denied.status, suffix).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    } finally {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, actor.memberId));
    }
  }
});
