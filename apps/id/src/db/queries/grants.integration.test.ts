import { bootstrap, systemActor } from "../../bootstrap.ts";
import { approveAdminCapability } from "../../__tests__/capabilities.ts";
import { adminScopes } from "../../http/admin/scopes.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  organizationCapabilities,
  entitlements,
  groupMembers,
  groups,
  members,
  oauthClients,
  oauthResources,
  organizations,
  users,
  systemBindings,
} from "../schema/index.ts";
import { effectiveGrants, hasPlatformWriter } from "./grants.ts";

const resource = "https://id.test/api/admin";
const otherResource = "https://id.test/api/other";
const day = 86_400_000;
type Window = { validFrom?: Date | null; validUntil?: Date | null };
let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, security_identifiers, users, organizations, oauth_resources cascade`,
  );
  await bootstrap(connection.db, systemActor("grant-fixture"), {
    platformOrganizationSlug: "bound-platform",
    platformOrganizationName: "Platform",
    adminResourceIdentifier: resource,
  });
  await connection.db
    .update(oauthResources)
    .set({
      allowedScopes: [
        ...adminScopes,
        "read",
        "write",
        "admin",
        "delete",
        "disabled",
      ],
    })
    .where(eq(oauthResources.identifier, resource));
  await connection.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: otherResource, name: "Other" });
});
afterAll(async () => {
  await connection.close();
});

async function insertUser() {
  const id = createId();
  await connection.db.insert(users).values({
    id,
    name: "Member",
    email: `${id}@example.com`,
    status: "active",
  });
  return id;
}

async function insertOrganization(
  slug = "example",
  status: "active" | "disabled" = "active",
  platform = false,
) {
  if (platform)
    return (await connection.db.select().from(systemBindings))[0]!
      .organizationId;
  const id = createId();
  await connection.db.insert(organizations).values({
    id,
    name: slug,
    slug,
    status,
    disabledAt: status === "disabled" ? new Date() : null,
  });
  await approveAdminCapability(connection.db, {
    organizationId: id,
    resource,
    scopes: ["read", "write", "admin", "delete", "disabled"],
  });
  return id;
}

async function insertMember(
  organizationId: string,
  userId: string,
  window: Window = {},
) {
  const id = createId();
  await connection.db
    .insert(members)
    .values({ id, organizationId, userId, ...window });
  return id;
}

async function insertGroup(
  organizationId: string,
  status: "active" | "disabled" = "active",
) {
  const id = createId();
  await connection.db
    .insert(groups)
    .values({ id, organizationId, slug: id, name: "Group", status });
  return id;
}

async function insertGroupMember(
  organizationId: string,
  groupId: string,
  memberId: string,
  window: Window = {},
) {
  await connection.db
    .insert(groupMembers)
    .values({ id: createId(), organizationId, groupId, memberId, ...window });
}

async function insertEntitlement(
  organizationId: string,
  options: Partial<
    Omit<typeof entitlements.$inferInsert, "id" | "organizationId">
  > = {},
) {
  await connection.db.insert(entitlements).values({
    id: createId(),
    organizationId,
    resource,
    scopes: ["read"],
    ...options,
  });
}

test("integration: organisation-wide grants require effective membership", async () => {
  const organizationId = await insertOrganization();
  await insertEntitlement(organizationId);
  const now = Date.now();
  for (const [window, effective] of [
    [{}, true],
    [{ validFrom: new Date(now - day), validUntil: new Date(now + day) }, true],
    [{ validUntil: new Date(now - day) }, false],
    [{ validFrom: new Date(now + day) }, false],
  ] as const) {
    const userId = await insertUser();
    await insertMember(organizationId, userId, window);
    expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
      effective
        ? [
            {
              organizationId,
              organizationSlug: "example",
              isPlatform: false,
              scopes: ["read"],
            },
          ]
        : [],
    );
  }
});

test("integration: group grants require effective group membership and an active group", async () => {
  const organizationId = await insertOrganization();
  const groupId = await insertGroup(organizationId);
  const disabledGroupId = await insertGroup(organizationId, "disabled");
  await insertEntitlement(organizationId, { groupId });
  await insertEntitlement(organizationId, {
    groupId: disabledGroupId,
    scopes: ["disabled"],
  });
  const now = Date.now();
  const activeUser = await insertUser();
  const activeMember = await insertMember(organizationId, activeUser);
  await insertGroupMember(organizationId, groupId, activeMember, {
    validFrom: new Date(now - day),
    validUntil: new Date(now + day),
  });
  expect(
    await effectiveGrants(connection.db, { userId: activeUser }, resource),
  ).toEqual([
    {
      organizationId,
      organizationSlug: "example",
      isPlatform: false,
      scopes: ["read"],
    },
  ]);
  for (const window of [
    { validUntil: new Date(now - day) },
    { validFrom: new Date(now + day) },
  ]) {
    const userId = await insertUser();
    const memberId = await insertMember(organizationId, userId);
    await insertGroupMember(organizationId, groupId, memberId, window);
    expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
      [],
    );
  }
  const outsideUser = await insertUser();
  await insertMember(organizationId, outsideUser);
  expect(
    await effectiveGrants(connection.db, { userId: outsideUser }, resource),
  ).toEqual([]);
  const disabledUser = await insertUser();
  const disabledMember = await insertMember(organizationId, disabledUser);
  await insertGroupMember(organizationId, disabledGroupId, disabledMember);
  expect(
    await effectiveGrants(connection.db, { userId: disabledUser }, resource),
  ).toEqual([]);
});

test("integration: member grants apply only to that member", async () => {
  const organizationId = await insertOrganization();
  const userId = await insertUser();
  const memberId = await insertMember(organizationId, userId);
  const otherUser = await insertUser();
  await insertMember(organizationId, otherUser);
  await insertEntitlement(organizationId, { memberId });
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual([
    {
      organizationId,
      organizationSlug: "example",
      isPlatform: false,
      scopes: ["read"],
    },
  ]);
  expect(
    await effectiveGrants(connection.db, { userId: otherUser }, resource),
  ).toEqual([]);
});

test("integration: unions and sorts distinct scopes across matching principals", async () => {
  const organizationId = await insertOrganization();
  const userId = await insertUser();
  const memberId = await insertMember(organizationId, userId);
  const groupId = await insertGroup(organizationId);
  await insertGroupMember(organizationId, groupId, memberId);
  await insertEntitlement(organizationId, {
    scopes: ["write", "read", "read"],
  });
  await insertEntitlement(organizationId, {
    groupId,
    scopes: ["read", "admin"],
  });
  await insertEntitlement(organizationId, {
    memberId,
    scopes: ["delete", "write"],
    validFrom: new Date(Date.now() - day),
    validUntil: new Date(Date.now() + day),
  });
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual([
    {
      organizationId,
      organizationSlug: "example",
      isPlatform: false,
      scopes: ["admin", "delete", "read", "write"],
    },
  ]);
});

for (const state of ["expired", "future", "disabled"] as const) {
  test(`integration: ignores an ${state} entitlement on its own`, async () => {
    const organizationId = await insertOrganization();
    const userId = await insertUser();
    await insertMember(organizationId, userId);
    await insertEntitlement(organizationId, {
      ...(state === "expired"
        ? { validUntil: new Date(Date.now() - day) }
        : {}),
      ...(state === "future" ? { validFrom: new Date(Date.now() + day) } : {}),
      ...(state === "disabled" ? { status: "disabled" as const } : {}),
    });
    expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
      [],
    );
  });
}

test("integration: ignores disabled organisations", async () => {
  const organizationId = await insertOrganization("disabled", "disabled");
  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId);
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
});

test("integration: ignores other resources and client targets", async () => {
  const organizationId = await insertOrganization();
  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId, { resource: otherResource });
  await connection.db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "cli", redirectUris: [] });
  await insertEntitlement(organizationId, { clientId: "cli", resource: null });
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
});

test("integration: isolates scope unions by organisation and orders by slug", async () => {
  const userId = await insertUser();
  const zebra = await insertOrganization("zebra");
  const alpha = await insertOrganization("alpha");
  await insertMember(zebra, userId);
  await insertMember(alpha, userId);
  await insertEntitlement(zebra, { scopes: ["write"] });
  await insertEntitlement(alpha, { scopes: ["read"] });
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual([
    {
      organizationId: alpha,
      organizationSlug: "alpha",
      isPlatform: false,
      scopes: ["read"],
    },
    {
      organizationId: zebra,
      organizationSlug: "zebra",
      isPlatform: false,
      scopes: ["write"],
    },
  ]);
});

test("integration: returns no grants without membership or matching entitlements", async () => {
  const userId = await insertUser();
  const organizationId = await insertOrganization();
  await insertEntitlement(organizationId);
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
  const emptyOrganization = await insertOrganization("empty");
  await insertMember(emptyOrganization, userId);
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
});

test("integration: accepts a transaction handle", async () => {
  const organizationId = await insertOrganization();
  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId);
  const grants = await connection.db.transaction(async (tx) =>
    effectiveGrants(tx, { userId }, resource),
  );
  expect(grants).toEqual([
    {
      organizationId,
      organizationSlug: "example",
      isPlatform: false,
      scopes: ["read"],
    },
  ]);
});

test("integration: root lockout follows effective group grants", async () => {
  const { db } = connection;
  const input = { resource };
  expect(await hasPlatformWriter(db, input)).toBe(false);
  const organizationId = await insertOrganization("platform", "active", true);
  const memberId = await insertMember(organizationId, await insertUser());
  expect(await hasPlatformWriter(db, input)).toBe(false);
  const groupId = await insertGroup(organizationId);

  await insertEntitlement(organizationId, {
    groupId,
    scopes: ["platform:write"],
  });
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await insertGroupMember(organizationId, groupId, memberId);
  expect(await hasPlatformWriter(db, input)).toBe(true);
  expect(
    await hasPlatformWriter(db, { ...input, resource: otherResource }),
  ).toBe(false);

  await db
    .update(members)
    .set({ validUntil: new Date(Date.now() - day) })
    .where(eq(members.id, memberId));
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await db
    .update(members)
    .set({ validUntil: null })
    .where(eq(members.id, memberId));
  await db
    .update(groupMembers)
    .set({ validUntil: new Date(Date.now() - day) })
    .where(eq(groupMembers.memberId, memberId));
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await db
    .update(groupMembers)
    .set({ validUntil: null })
    .where(eq(groupMembers.memberId, memberId));
  await db.update(entitlements).set({ status: "disabled" });
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await db.update(entitlements).set({ status: "active" });
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, organizationId));
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await db
    .update(organizations)
    .set({ status: "active", disabledAt: null })
    .where(eq(organizations.id, organizationId));
  await db
    .update(groups)
    .set({ status: "disabled" })
    .where(eq(groups.id, groupId));
  expect(await hasPlatformWriter(db, input)).toBe(false);
  await db
    .update(groups)
    .set({ status: "active" })
    .where(eq(groups.id, groupId));
  expect(await hasPlatformWriter(db, input)).toBe(true);
});

test.each(["organization", "member"] as const)(
  "integration: root lockout recognises %s entitlements",
  async (target) => {
    const organizationId = await insertOrganization("platform", "active", true);

    const memberId = await insertMember(organizationId, await insertUser());
    await insertEntitlement(organizationId, {
      memberId: target === "member" ? memberId : undefined,
      scopes: ["platform:read"],
    });
    const input = { resource };
    expect(await hasPlatformWriter(connection.db, input)).toBe(false);
    await connection.db
      .update(entitlements)
      .set({ scopes: ["platform:write"] });
    expect(await hasPlatformWriter(connection.db, input)).toBe(true);
  },
);

test("effective grants and platform writer detection require an active global user", async () => {
  const db = connection.db;
  const organizationId = await insertOrganization("platform", "active", true);
  const userId = await insertUser();
  await insertMember(organizationId, userId);

  await insertEntitlement(organizationId, { scopes: ["platform:write"] });
  for (const status of ["active", "inert", "disabled", "active"] as const) {
    await db
      .update(users)
      .set({ status, disabledAt: status === "disabled" ? new Date() : null })
      .where(eq(users.id, userId));
    const grants = await effectiveGrants(db, { userId }, resource);
    expect(grants).toHaveLength(status === "active" ? 1 : 0);
    expect(await hasPlatformWriter(db, { resource })).toBe(status === "active");
  }
});

test("direct administrator assignments cannot exceed their platform capability", async () => {
  const organizationId = await insertOrganization("platform", "active", true);

  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId, {
    scopes: ["platform:read", "platform:write"],
  });
  await connection.db
    .update(organizationCapabilities)
    .set({ scopes: ["platform:read"] })
    .where(eq(organizationCapabilities.organizationId, organizationId));
  expect(
    (await effectiveGrants(connection.db, { userId }, resource))[0]?.scopes,
  ).toEqual(["platform:read"]);
  expect(await hasPlatformWriter(connection.db, { resource })).toBe(false);
});

test("direct-session policy rechecks capability windows and the current enabled resource vocabulary", async () => {
  const organizationId = await insertOrganization("platform", "active", true);
  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId, {
    scopes: ["platform:read", "platform:write"],
  });
  const [cap] = await connection.db
    .select()
    .from(organizationCapabilities)
    .where(eq(organizationCapabilities.organizationId, organizationId));
  for (const patch of [
    { status: "disabled" as const },
    { status: "active" as const, validFrom: new Date("2100-01-01") },
    { validFrom: null, validUntil: new Date("2000-01-01") },
  ]) {
    await connection.db
      .update(organizationCapabilities)
      .set(patch)
      .where(eq(organizationCapabilities.id, cap!.id));
    expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
      [],
    );
    expect(await hasPlatformWriter(connection.db, { resource })).toBe(false);
  }
  await connection.db
    .update(organizationCapabilities)
    .set({ validUntil: null })
    .where(eq(organizationCapabilities.id, cap!.id));
  expect(await hasPlatformWriter(connection.db, { resource })).toBe(true);
  await connection.db
    .update(oauthResources)
    .set({ allowedScopes: ["platform:read"] })
    .where(eq(oauthResources.identifier, resource));
  expect(
    (await effectiveGrants(connection.db, { userId }, resource))[0]?.scopes,
  ).toEqual(["platform:read"]);
  expect(await hasPlatformWriter(connection.db, { resource })).toBe(false);
  await connection.db
    .update(oauthResources)
    .set({ disabled: true })
    .where(eq(oauthResources.identifier, resource));
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
});

test("removing a tenant admin ceiling leaves assignments but removes their authority", async () => {
  const organizationId = await insertOrganization();
  const userId = await insertUser();
  await insertMember(organizationId, userId);
  await insertEntitlement(organizationId);
  expect(
    await effectiveGrants(connection.db, { userId }, resource),
  ).toHaveLength(1);
  await connection.db
    .delete(organizationCapabilities)
    .where(eq(organizationCapabilities.organizationId, organizationId));
  expect(await effectiveGrants(connection.db, { userId }, resource)).toEqual(
    [],
  );
  expect(
    await connection.db
      .select()
      .from(entitlements)
      .where(eq(entitlements.organizationId, organizationId)),
  ).toHaveLength(1);
});
