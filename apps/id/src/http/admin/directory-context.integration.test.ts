import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import * as organizations from "../../services/organizations.ts";
import * as summaries from "../../services/summary.ts";
import * as providers from "../../services/sso-providers.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
import { createGroup, addGroupMember } from "../../__tests__/group-queries.ts";
import { createEntitlement } from "../../__tests__/entitlement-queries.ts";
import { members } from "../../db/schema/index.ts";
import * as groups from "../../services/groups.ts";
import * as domains from "../../services/domains.ts";
import * as entitlements from "../../services/entitlements.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
let fixture: AdminFixture;
let groupId: string;
let entitlementId: string;
beforeAll(async () => {
  fixture = await createAdminFixture();
  const organizationId = fixture.tenant.organizationId;
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
const readers = () => [
  organizations.getOrganization,
  summaries.getOrganizationSummary,
  providers.getSsoProvider,
  (context: TenantReadContext<"directory">) =>
    groups.listGroups(context, { limit: 10 }),
  (context: TenantReadContext<"directory">) =>
    groups.getGroup(context, groupId),
  (context: TenantReadContext<"directory">) =>
    groups.listGroupMembers(context, groupId, { limit: 10 }),
  (context: TenantReadContext<"directory">) =>
    groups.getGroupMember(
      context,
      groupId,
      fixture.principals.tenantReader.memberId,
    ),
  (context: TenantReadContext<"directory">) =>
    domains.listDomains(context, { limit: 10 }),
  (context: TenantReadContext<"directory">) =>
    entitlements.listEntitlements(context, { limit: 10 }),
  (context: TenantReadContext<"directory">) =>
    entitlements.getEntitlement(context, entitlementId),
];

test("tenant configuration readers reject copied, expired and non-directory contexts", async () => {
  let escaped!: TenantReadContext<"directory">;
  await inTenantRead(
    fixture.db,
    fixture.tenant.organizationId,
    "directory",
    async (context) => {
      escaped = context;
      for (const read of readers()) {
        expect(await read(context)).toBeDefined();
        await expect(read({ ...context })).rejects.toThrow(
          "Invalid or expired",
        );
      }
    },
  );
  for (const read of readers())
    await expect(read(escaped)).rejects.toThrow("Invalid or expired");
  await inTenantRead(
    fixture.db,
    fixture.tenant.organizationId,
    "configuration",
    async (context) => {
      for (const read of readers())
        await expect(
          read(context as unknown as TenantReadContext<"directory">),
        ).rejects.toThrow("Invalid or expired");
    },
  );
});

test("all ten tenant configuration routes recheck membership inside their read transaction", async () => {
  const base = `/api/admin/v1/organizations/${fixture.tenant.organizationId}`;
  const actor = fixture.principals.tenantReader;
  const paths = [
    "",
    "/summary",
    "/sso-provider",
    "/groups",
    `/groups/${groupId}`,
    `/groups/${groupId}/members`,
    `/groups/${groupId}/members/${actor.memberId}`,
    "/domains",
    "/entitlements",
    `/entitlements/${entitlementId}`,
  ];
  for (const suffix of paths) {
    const headers = fixture.headers("tenantReader");
    const send = () => fixture.app.request(base + suffix, { headers });
    const accepted = await send();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
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
      const denied = await send();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, actor.memberId));
    }
  }
});
