import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
import {
  users,
  members,
  oauthClients,
  oauthResources,
  auditEvents,
} from "../db/schema/index.ts";
import { createGroup, addGroupMember } from "../__tests__/group-queries.ts";
import { createEntitlement } from "../__tests__/entitlement-queries.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
const past = new Date("2000-01-01T00:00:00Z");
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [
    org.id,
    org.id,
    org.id,
    other.id,
  ].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
      status: "active",
    });
    await db.insert(members).values({
      id,
      organizationId,
      userId,
      validUntil: index === 2 ? past : null,
    });
    ids.push(id);
  }
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  const foreignGroup = await createGroup(db, {
    organizationId: other.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const resource = "https://tutor.example";
  const clientId = "test-client";
  await db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Tutor",
    allowedScopes: ["read", "write", "admin"],
  });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId, redirectUris: [], scopes: ["openid"] });
  return { db, org, other, ids, group, foreignGroup, resource, clientId };
}
import * as service from "./access.ts";
import * as accessQueries from "../db/queries/access.ts";
import { inTenant, inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
import type { TenantReadContext } from "./tenant-context.ts";
const getMemberAccess = (db: Database, org: string, memberId: string) =>
  inTenantRead(db, org, "memberAccess", (context) =>
    service.getMemberAccess(context, memberId),
  );
const listTargetAccess = (
  db: Database,
  org: string,
  target: Parameters<typeof service.listTargetAccess>[1],
  page: Parameters<typeof service.listTargetAccess>[2],
) =>
  inTenantRead(db, org, "directory", (context) =>
    service.listTargetAccess(context, target, page),
  );
test("access queries reject raw database and tenant arguments", async () => {
  const { db, org, ids, resource } = await seed();
  await expect(
    Reflect.apply(accessQueries.memberAccess, undefined, [db, org.id, ids[0]!]),
  ).rejects.toThrow("Invalid or expired");
  await expect(
    Reflect.apply(accessQueries.targetAccess, undefined, [
      db,
      org.id,
      { resource },
      { limit: 1 },
    ]),
  ).rejects.toThrow("Invalid or expired");
});
test("access query contexts bind tenant, purpose and callback lifetime", async () => {
  const { db, org, other, ids, resource } = await seed();
  for (const organizationId of [org.id, other.id])
    await createEntitlement(db, { organizationId, resource, scopes: ["read"] });
  let escaped!: TenantReadContext<"memberAccess">;
  await inTenantRead(db, org.id, "memberAccess", async (context) => {
    escaped = context;
    expect(
      (await accessQueries.memberAccess(context, ids[0]!)).targets,
    ).toHaveLength(1);
    expect(await accessQueries.memberAccess(context, ids[3]!)).toEqual({
      effective: false,
      targets: [],
    });
    await expect(
      accessQueries.memberAccess({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      accessQueries.targetAccess(
        context as unknown as TenantReadContext<"directory">,
        { resource },
        { limit: 10 },
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(accessQueries.memberAccess(escaped, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
  let directory!: TenantReadContext<"directory">;
  await inTenantRead(db, org.id, "directory", async (context) => {
    directory = context;
    const page = await accessQueries.targetAccess(
      context,
      { resource },
      { limit: 10 },
    );
    expect(page.items.map((row) => row.memberId).sort()).toEqual(
      [ids[0]!, ids[1]!].sort(),
    );
    await expect(
      accessQueries.targetAccess({ ...context }, { resource }, { limit: 10 }),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      accessQueries.memberAccess(
        context as unknown as TenantReadContext<"memberAccess">,
        ids[0]!,
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(
    accessQueries.targetAccess(directory, { resource }, { limit: 10 }),
  ).rejects.toThrow("Invalid or expired");
  let command!: import("./tenant-context.ts").TenantMemberContext;
  await inTenant(db, org.id, async (context) => {
    command = context;
    expect(
      (await accessQueries.memberAccess(context, ids[0]!)).targets,
    ).toHaveLength(1);
    await expect(
      accessQueries.memberAccess({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(accessQueries.memberAccess(command, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
});
test("access service checks organisation, member and target existence without auditing reads", async () => {
  const { db, org, other, ids, resource, clientId } = await seed();
  await createEntitlement(db, {
    organizationId: org.id,
    memberId: ids[0]!,
    resource,
    scopes: ["read"],
  });
  await createEntitlement(db, {
    organizationId: org.id,
    memberId: ids[0]!,
    clientId,
    scopes: ["openid"],
  });
  expect(await getMemberAccess(db, org.id, ids[0]!)).toMatchObject({
    effective: true,
    targets: [
      expect.objectContaining({ id: resource }),
      expect.objectContaining({ id: clientId }),
    ],
  });
  expect(await getMemberAccess(db, org.id, ids[2]!)).toEqual({
    effective: false,
    targets: [],
  });
  expect(await getMemberAccess(db, org.id, ids[1]!)).toEqual({
    effective: true,
    targets: [],
  });
  for (const [organizationId, memberId] of [
    [createId(), ids[0]!],
    [org.id, ids[3]!],
    [other.id, ids[0]!],
    [org.id, createId()],
  ])
    await expect(
      getMemberAccess(db, organizationId!, memberId!),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  for (const target of [{ resource }, { clientId }]) {
    const page = await listTargetAccess(db, org.id, target, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      memberId: ids[0],
      email: "person0@example.com",
      name: "Person 0",
    });
    expect(page.nextCursor).toBeNull();
    expect(await listTargetAccess(db, other.id, target, { limit: 1 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      listTargetAccess(db, createId(), target, { limit: 1 }),
    ).rejects.toMatchObject({ status: 404 });
  }
  for (const target of [
    { resource: "https://none.example" },
    { clientId: "missing" },
  ])
    await expect(
      listTargetAccess(db, org.id, target, { limit: 1 }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await db.select().from(auditEvents)).toEqual([]);
});

test("access services reject forged, expired and differently scoped contexts", async () => {
  const { db, org, ids, resource } = await seed();
  let escaped!: TenantReadContext<"memberAccess">;
  await inTenantRead(db, org.id, "memberAccess", async (context) => {
    escaped = context;
    await expect(
      service.getMemberAccess({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      service.listTargetAccess(
        context as unknown as TenantReadContext<"directory">,
        { resource },
        { limit: 1 },
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(service.getMemberAccess(escaped, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
  await inTenantRead(db, org.id, "directory", async (context) => {
    await expect(
      service.getMemberAccess(
        context as unknown as TenantReadContext<"memberAccess">,
        ids[0]!,
      ),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      service.listTargetAccess({ ...context }, { resource }, { limit: 1 }),
    ).rejects.toThrow("Invalid or expired");
  });
});
