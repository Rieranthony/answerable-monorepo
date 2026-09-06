import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  entitlements,
  groupMembers,
  groups,
  members,
  oauthClients,
  oauthResources,
  organizations,
  users,
} from "../schema/index.ts";
import { effectiveGrants } from "./grants.ts";

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
    sql`truncate table users, organizations, oauth_resources cascade`,
  );
  await connection.db.insert(oauthResources).values([
    { id: createId(), identifier: resource, name: "Admin" },
    { id: createId(), identifier: otherResource, name: "Other" },
  ]);
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
) {
  const id = createId();
  await connection.db.insert(organizations).values({
    id,
    name: slug,
    slug,
    status,
    disabledAt: status === "disabled" ? new Date() : null,
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
    .values({ organizationId, groupId, memberId, ...window });
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
        ? [{ organizationId, organizationSlug: "example", scopes: ["read"] }]
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
    { organizationId, organizationSlug: "example", scopes: ["read"] },
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
    { organizationId, organizationSlug: "example", scopes: ["read"] },
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
    { organizationId: alpha, organizationSlug: "alpha", scopes: ["read"] },
    { organizationId: zebra, organizationSlug: "zebra", scopes: ["write"] },
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
    { organizationId, organizationSlug: "example", scopes: ["read"] },
  ]);
});
