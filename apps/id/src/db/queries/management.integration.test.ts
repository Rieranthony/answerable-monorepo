import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  organizations,
  users,
  members,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../schema/index.ts";
import * as clients from "../../__tests__/client-queries.ts";
import * as resources from "../../__tests__/resource-queries.ts";
import * as domains from "../../__tests__/domain-queries.ts";
import * as entitlements from "../../__tests__/entitlement-queries.ts";
import { listUsers } from "../../__tests__/user-queries.ts";
import { listMembers as queryMembers, type MemberQuery } from "./members.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
const listMembers = (
  db: import("../client.ts").Database,
  organizationId: string,
  query: MemberQuery,
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queryMembers(context, query),
  );
import {
  listAuditEvents,
  listUserAuditEvents,
  recordAuditEvent,
} from "../../__tests__/audit-queries.ts";
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
async function seed() {
  const db = connection.db;
  const org = { id: createId(), slug: "one", name: "One" };
  const other = { id: createId(), slug: "two", name: "Two" };
  await db.insert(organizations).values([org, other]);
  const user = { id: createId(), email: "person@example.com", name: "Person" };
  const another = {
    id: createId(),
    email: "otherperson@example.com",
    name: "Other",
  };
  await db.insert(users).values([user, another]);
  const member = { id: createId(), organizationId: org.id, userId: user.id };
  await db
    .insert(members)
    .values([
      member,
      { id: createId(), organizationId: org.id, userId: another.id },
    ]);
  return { db, org, other, user, another, member };
}
test("client erasure respects entitlement references and cascades links, tokens and consents", async () => {
  const { db, org, user } = await seed();
  const client = await clients.createClient(db, {
    clientId: "erase",
    organizationId: org.id,
    redirectUris: [],
  });
  const resource = await resources.createResource(db, {
    identifier: "https://erase.example",
    name: "Erase",
    allowedScopes: ["read"],
  });
  await clients.linkClientResource(db, client.clientId, resource.identifier);
  expect(
    (await resources.listResourceClients(db, resource.identifier)).map(
      (row) => row.clientId,
    ),
  ).toEqual([client.clientId]);
  const grant = await entitlements.createEntitlement(db, {
    organizationId: org.id,
    clientId: client.clientId,
    scopes: ["read"],
  });
  expect(await clients.countClientEntitlements(db, client.clientId)).toBe(1);
  await expect(clients.deleteClient(db, client.clientId)).rejects.toThrow();
  await entitlements.deleteEntitlement(db, org.id, grant.id);
  expect(await clients.countClientEntitlements(db, client.clientId)).toBe(0);
  const token = {
    id: createId(),
    clientId: client.clientId,
    userId: user.id,
    token: createId(),
    scopes: ["read"],
    expiresAt: new Date(Date.now() + 60000),
  };
  await db.insert(oauthRefreshTokens).values(token);
  await db
    .insert(oauthAccessTokens)
    .values({ ...token, id: createId(), refreshId: token.id });
  await db.insert(oauthConsents).values({
    id: createId(),
    clientId: client.clientId,
    userId: user.id,
    scopes: ["read"],
  });
  await clients.deleteClient(db, client.clientId);
  expect(await clients.findClient(db, client.clientId)).toBeNull();
  expect(await clients.listClientResources(db, client.clientId)).toEqual([]);
  expect(await resources.listResourceClients(db, resource.identifier)).toEqual(
    [],
  );
  for (const table of [oauthAccessTokens, oauthRefreshTokens])
    expect(await db.select().from(table)).toEqual([]);
  expect(await db.select().from(oauthConsents)).toMatchObject([
    { deletedAt: expect.any(Date) },
  ]);
});
test("domain deletion is scoped to its organisation", async () => {
  const { db, org, other } = await seed();
  const domain = await domains.createOrganizationDomain(db, {
    organizationId: org.id,
    domain: "one.example.com",
  });
  await domains.deleteOrganizationDomain(db, other.id, domain.id);
  expect(
    await domains.findOrganizationDomain(db, org.id, domain.id),
  ).not.toBeNull();
  await domains.deleteOrganizationDomain(db, org.id, domain.id);
  expect(
    await domains.findOrganizationDomain(db, org.id, domain.id),
  ).toMatchObject({
    id: domain.id,
    status: "disabled",
    deletedAt: expect.any(Date),
  });
});
test("exact email combines with q and does not match suffixes", async () => {
  const { db, org, user } = await seed();
  for (const query of [
    { email: user.email.toUpperCase() },
    { email: user.email, q: "person" },
  ]) {
    expect(
      (await listUsers(db, { ...query, limit: 10 })).map((row) => row.id),
    ).toEqual([user.id]);
    expect(
      (await listMembers(db, org.id, { ...query, limit: 10 })).map(
        (row) => row.userId,
      ),
    ).toEqual([user.id]);
  }
  for (const query of [
    { email: "missing@example.com" },
    { email: user.email, q: "other" },
  ]) {
    expect(await listUsers(db, { ...query, limit: 10 })).toEqual([]);
    expect(await listMembers(db, org.id, { ...query, limit: 10 })).toEqual([]);
  }
});
test("all entitlements joins organisations and applies filters and cursors", async () => {
  const { db, org, other, member } = await seed();
  const client = await clients.createClient(db, {
    clientId: "review",
    redirectUris: [],
  });
  const resource = await resources.createResource(db, {
    identifier: "https://review.example",
    name: "Review",
    allowedScopes: ["read"],
  });
  const first = await entitlements.createEntitlement(db, {
    organizationId: org.id,
    clientId: client.clientId,
    memberId: member.id,
    scopes: ["read"],
  });
  const second = await entitlements.createEntitlement(db, {
    organizationId: other.id,
    clientId: client.clientId,
    scopes: ["read"],
  });
  await entitlements.createEntitlement(db, {
    organizationId: other.id,
    resource: resource.identifier,
    scopes: ["read"],
  });
  const rows = await entitlements.listAllEntitlements(db, {
    clientId: client.clientId,
    status: "active",
    limit: 1,
  });
  expect(rows.map((row) => row.organization.slug)).toEqual(["two", "one"]);
  expect(
    (
      await entitlements.listAllEntitlements(db, {
        clientId: client.clientId,
        cursor: second.id,
        limit: 1,
      })
    ).map((row) => row.id),
  ).toEqual([first.id]);
  expect(
    await entitlements.listAllEntitlements(db, {
      status: "disabled",
      limit: 10,
    }),
  ).toEqual([]);
  expect(
    await entitlements.listAllEntitlements(db, {
      resource: resource.identifier,
      limit: 10,
    }),
  ).toHaveLength(1);
  expect(
    await entitlements.listAllEntitlements(db, {
      memberId: member.id,
      limit: 10,
    }),
  ).toHaveLength(1);
  expect(
    await entitlements.listAllEntitlements(db, {
      groupId: createId(),
      limit: 10,
    }),
  ).toEqual([]);
});
test("user audit subject matches stay inside filters, including deleted sessions", async () => {
  const { db, org, user, another, member } = await seed();
  const rows = [];
  for (const input of [
    { actorId: user.id, targetType: "route", targetId: "listClients" },
    { targetType: "user", targetId: user.id },
    { targetType: "member", targetId: member.id },
    { targetType: "group_member", targetId: member.id },
    { targetType: "session", targetId: createId(), data: { userId: user.id } },
  ])
    rows.push(
      await recordAuditEvent(db, {
        actorType: "user",
        actorId: another.id,
        organizationId: org.id,
        action: "trail",
        outcome: "denied",
        ...input,
      }),
    );
  for (const input of [
    { targetType: "user", targetId: another.id },
    { targetType: "route", targetId: member.id },
    { targetType: "session", data: { userId: another.id } },
    { targetType: "route", data: { userId: user.id } },
  ])
    await recordAuditEvent(db, {
      actorType: "user",
      actorId: another.id,
      action: "trail",
      outcome: "success",
      ...input,
    });
  const expected = rows.toReversed();
  expect(
    (await listUserAuditEvents(db, user.id, {}, { limit: 10 })).items,
  ).toEqual(expected);
  const filters = {
    action: "trail",
    outcome: "denied" as const,
    from: new Date("2000-01-01"),
    to: new Date("2100-01-01"),
  };
  expect(
    (await listUserAuditEvents(db, user.id, filters, { limit: 10 })).items,
  ).toEqual(expected);
  const page = await listUserAuditEvents(db, user.id, filters, { limit: 1 });
  expect(page.nextCursor).toBe(expected[0]!.id);
  expect(
    (
      await listUserAuditEvents(db, user.id, filters, {
        limit: 10,
        cursor: page.nextCursor!,
      })
    ).items,
  ).toEqual(expected.slice(1));
  for (const filter of [
    { action: "missing" },
    { outcome: "success" as const },
    { from: new Date("2100-01-01") },
    { to: new Date("2000-01-01") },
  ])
    expect(
      (await listUserAuditEvents(db, user.id, filter, { limit: 10 })).items,
    ).toEqual([]);
  expect(
    (await listAuditEvents(db, { outcome: "denied" }, { limit: 10 })).items,
  ).toEqual(expected);
  expect(
    (await listAuditEvents(db, { outcome: "failure" }, { limit: 10 })).items,
  ).toEqual([]);
  await db.delete(members).where(eq(members.id, member.id));
});
