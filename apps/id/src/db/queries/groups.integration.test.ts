import * as productionGroupQueries from "./groups.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { createId } from "../../lib/id.ts";
import { users, members } from "../schema/index.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [org.id, org.id, other.id].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
    });
    await db.insert(members).values({ id, organizationId, userId });
    ids.push(id);
  }
  return { db, org, other, ids };
}
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
import * as queries from "../../__tests__/group-queries.ts";
test("group query entry rejects a raw database instead of issued authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionGroupQueries.listGroups, undefined, [
        connection.db,
        createId(),
        { limit: 1 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});
test("group CRUD is scoped, filtered and paginated", async () => {
  const { db, org, other } = await seed();
  const a = await queries.createGroup(db, {
    organizationId: org.id,
    slug: "finance",
    name: "Accounts",
    externalId: "directory",
  });
  const b = await queries.createGroup(db, {
    organizationId: org.id,
    slug: "sales",
    name: "Sales",
  });
  await queries.createGroup(db, {
    organizationId: other.id,
    slug: "finance",
    name: "Other",
    externalId: "directory",
  });
  expect(await queries.findGroup(db, org.id, a.id)).toEqual(a);
  expect(
    (await queries.listGroups(db, org.id, { limit: 1 })).map((row) => row.id),
  ).toEqual([b.id, a.id]);
  expect(
    (await queries.listGroups(db, org.id, { limit: 1, cursor: b.id })).map(
      (row) => row.id,
    ),
  ).toEqual([a.id]);
  for (const q of ["FINANCE", "aCCouNts"])
    expect(
      (await queries.listGroups(db, org.id, { limit: 10, q })).map(
        (row) => row.id,
      ),
    ).toEqual([a.id]);
  expect(
    await queries.updateGroup(db, org.id, a.id, {
      name: "New",
      externalId: null,
    }),
  ).toMatchObject({ name: "New", externalId: null });
  expect(
    await queries.setGroupStatus(db, org.id, a.id, "disabled"),
  ).toMatchObject({ status: "disabled" });
  expect(
    (
      await queries.listGroups(db, org.id, { limit: 10, status: "disabled" })
    ).map((row) => row.id),
  ).toEqual([a.id]);
  expect(
    await queries.setGroupStatus(db, org.id, a.id, "active"),
  ).toMatchObject({ status: "active" });
  const missingOrganizationId = createId();
  for (const organizationId of [other.id, missingOrganizationId]) {
    if (organizationId === missingOrganizationId)
      await expect(
        queries.findGroup(db, organizationId, a.id),
      ).rejects.toMatchObject({ status: 404 });
    else expect(await queries.findGroup(db, organizationId, a.id)).toBeNull();
    expect(
      await queries.updateGroup(db, organizationId, a.id, { name: "Wrong" }),
    ).toBeNull();
    expect(
      await queries.setGroupStatus(db, organizationId, a.id, "disabled"),
    ).toBeNull();
    await queries.deleteGroup(db, organizationId, a.id);
  }
  expect(await queries.findGroup(db, org.id, a.id)).not.toBeNull();
  await queries.deleteGroup(db, org.id, a.id);
  expect(await queries.findGroup(db, org.id, a.id)).toBeNull();
});
test("group membership upserts preserve omitted windows, compute effectiveness and enforce composite foreign keys", async () => {
  const { db, org, other, ids } = await seed();
  const group = await queries.createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  const input = {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  };
  const added = await queries.addGroupMember(db, input);
  expect(await queries.findGroupMember(db, org.id, group.id, ids[0]!)).toEqual(
    added,
  );
  expect(
    (
      await queries.upsertGroupMember(db, {
        ...input,
        validFrom: past,
        validUntil: future,
      })
    ).created,
  ).toBe(false);
  expect((await queries.upsertGroupMember(db, input)).row).toMatchObject({
    validFrom: past,
    validUntil: future,
  });
  expect(
    (await queries.listGroupMembers(db, org.id, group.id, { limit: 10 }))[0],
  ).toMatchObject({
    memberId: ids[0],
    email: "person0@example.com",
    name: "Person 0",
    effective: true,
  });
  const second = await queries.upsertGroupMember(db, {
    ...input,
    memberId: ids[1]!,
    validFrom: future,
  });
  expect(second.created).toBe(true);
  expect(
    (await queries.listGroupMembers(db, org.id, group.id, { limit: 1 })).map(
      (row) => [row.memberId, row.effective],
    ),
  ).toEqual([
    [ids[1], false],
    [ids[0], true],
  ]);
  expect(
    (
      await queries.listGroupMembers(db, org.id, group.id, {
        limit: 1,
        cursor: ids[1],
      })
    ).map((row) => row.memberId),
  ).toEqual([ids[0]!]);
  await queries.upsertGroupMember(db, {
    ...input,
    validFrom: null,
    validUntil: past,
  });
  expect(
    (await queries.listGroupMembers(db, org.id, group.id, { limit: 10 }))[1]
      ?.effective,
  ).toBe(false);
  await queries.upsertGroupMember(db, { ...input, validUntil: null });
  expect(
    (await queries.listGroupMembers(db, org.id, group.id, { limit: 10 }))[1]
      ?.effective,
  ).toBe(true);
  await expect(
    queries.upsertGroupMember(db, {
      ...input,
      validFrom: future,
      validUntil: past,
    }),
  ).rejects.toThrow();
  await expect(
    queries.addGroupMember(db, { ...input, memberId: ids[2]! }),
  ).rejects.toThrow();
  await expect(
    queries.upsertGroupMember(db, { ...input, memberId: ids[2]! }),
  ).rejects.toThrow();
  await expect(
    queries.upsertGroupMember(db, { ...input, organizationId: other.id }),
  ).rejects.toThrow();
  expect(
    await queries.findGroupMember(db, other.id, group.id, ids[0]!),
  ).toBeNull();
  expect(
    await queries.listGroupMembers(db, other.id, group.id, { limit: 10 }),
  ).toEqual([]);
  expect(
    await queries.removeGroupMember(db, other.id, group.id, ids[0]!),
  ).toBeNull();
  expect(
    await queries.removeGroupMember(db, org.id, group.id, ids[0]!),
  ).toMatchObject({ deletedAt: expect.any(Date) });
  expect(
    await queries.removeGroupMember(db, org.id, group.id, ids[0]!),
  ).toBeNull();
  expect(
    await queries.findGroupMember(db, org.id, group.id, ids[0]!),
  ).toBeNull();
  await db.delete(members).where(eq(members.id, ids[1]!));
  expect(
    await queries.listGroupMembers(db, org.id, group.id, { limit: 10 }),
  ).toEqual([]);
});

test("assignment instances and revisions survive updates but not recreation", async () => {
  const { db, org, ids } = await seed();
  const group = await queries.createGroup(db, {
    organizationId: org.id,
    slug: "assignment",
    name: "Assignment",
  });
  const target = {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  };
  const first = await queries.addGroupMember(db, target);
  expect(first.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(first.revision).toBe(1);
  const changed = await queries.upsertGroupMember(db, {
    ...target,
    validUntil: future,
  });
  expect(changed.created).toBe(false);
  expect(changed.row.id).toBe(first.id);
  expect(changed.row.revision).toBe(2);
  const noop = await queries.upsertGroupMember(db, {
    ...target,
    validUntil: future,
  });
  expect(noop.row).toEqual(changed.row);
  for (const patch of [
    sql`id = ${createId()}`,
    sql`revision = 1`,
    sql`member_id = ${ids[1]}`,
    sql`organization_id = ${createId()}`,
    sql`group_id = ${createId()}`,
  ]) {
    await expect(
      db
        .execute(sql`update group_members set ${patch} where id = ${first.id}`)
        .execute(),
    ).rejects.toThrow();
  }
  await db.execute(
    sql`update group_members set valid_until = null where id = ${first.id}`,
  );
  expect(
    (await queries.findGroupMember(db, org.id, group.id, ids[0]!))?.revision,
  ).toBe(3);
  expect((await queries.findGroup(db, org.id, group.id))?.revision).toBe(
    group.revision,
  );
  await queries.removeGroupMember(db, org.id, group.id, ids[0]!);
  const replacement = await queries.upsertGroupMember(db, target);
  expect(replacement.created).toBe(true);
  expect(replacement.row.id).not.toBe(first.id);
  expect(replacement.row.revision).toBe(1);
});
