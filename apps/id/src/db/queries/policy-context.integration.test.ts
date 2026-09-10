import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
import {
  inPlatformRead,
  inPlatformWrite,
} from "../../__tests__/platform-context.ts";
import * as groups from "./groups.ts";
import * as entitlements from "./entitlements.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});

test("policy queries reject raw, copied, expired and wrong-purpose contexts", async () => {
  const organizationId = fixture.platform.organizationId;
  const groupId = fixture.platform.groupId;
  const memberId = fixture.principals.platformAdmin.memberId;
  const entitlementId = crypto.randomUUID();
  const reads = [
    [groups.listGroups, [{ limit: 10 }]],
    [groups.findGroup, [groupId]],
    [groups.listGroupMembers, [groupId, { limit: 10 }]],
    [groups.findGroupMember, [groupId, memberId]],
    [entitlements.listEntitlements, [{ limit: 10 }]],
    [entitlements.findEntitlement, [entitlementId]],
  ] as const;
  const writes = [
    [
      groups.createGroup,
      [{ organizationId, slug: "context", name: "Context" }],
    ],
    [groups.findGroupForCommand, [organizationId, groupId]],
    [groups.readGroupPolicyForCommand, [organizationId, groupId]],
    [groups.updateGroup, [organizationId, groupId, { name: "Changed" }]],
    [groups.setGroupStatus, [organizationId, groupId, "disabled"]],
    [groups.deleteGroup, [organizationId, groupId]],
    [groups.findGroupMemberForCommand, [organizationId, groupId, memberId]],
    [groups.upsertGroupMember, [{ organizationId, groupId, memberId }]],
    [groups.removeGroupMember, [organizationId, groupId, memberId]],
    [
      entitlements.createEntitlement,
      [
        {
          organizationId,
          resource: fixture.platform.adminResource,
          scopes: ["org:read"],
        },
      ],
    ],
    [entitlements.findEntitlementForCommand, [organizationId, entitlementId]],
    [entitlements.readEntitlementAudience, [organizationId, null]],
    [entitlements.readEntitlementAudience, [organizationId, groupId]],
    [
      entitlements.updateEntitlement,
      [organizationId, entitlementId, { scopes: ["org:read"] }],
    ],
    [
      entitlements.setEntitlementStatus,
      [organizationId, entitlementId, "disabled"],
    ],
    [entitlements.deleteEntitlement, [organizationId, entitlementId]],
  ] as const;
  const globalReads = [
    [entitlements.listAllEntitlements, [{ limit: 10 }]],
  ] as const;
  const all = [...reads, ...writes, ...globalReads];
  async function reject(context: unknown, cases: typeof all) {
    for (const [query, args] of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(query, undefined, [context, ...args]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(fixture.db, all);
  let expired: unknown;
  await inTenantRead(
    fixture.db,
    organizationId,
    "directory",
    async (context) => {
      expired = context;
      await reject({ ...context }, all);
      await reject(context, [...writes, ...globalReads]);
      for (const [query, args] of reads)
        await Reflect.apply(query, undefined, [context, ...args]);
    },
  );
  await reject(expired, all);
  await inTenantRead(fixture.db, organizationId, "history", async (context) =>
    reject(context, all),
  );
  await inPlatformWrite(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...reads, ...globalReads]);
  });
  await reject(expired, all);
  await inPlatformRead(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...reads, ...writes]);
    expect(
      (await entitlements.listAllEntitlements(context, { limit: 10 })).length,
    ).toBeGreaterThan(0);
  });
  await reject(expired, all);
});
