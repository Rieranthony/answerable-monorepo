import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "./organizations.ts";
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
import * as queries from "./members.ts";
import { createGroup, addGroupMember } from "./groups.ts";
test("members expose user summaries and memberships, filter windows, and isolate organisations", async () => {
  const { db, org, other, ids } = await seed();
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const row = await queries.findMember(db, org.id, ids[0]!);
  expect(row).toMatchObject({
    id: ids[0],
    email: "person0@example.com",
    name: "Person 0",
    effective: true,
    groups: [
      {
        groupId: group.id,
        slug: "team",
        name: "Team",
        validFrom: null,
        validUntil: null,
      },
    ],
  });
  expect(row).not.toHaveProperty("role");
  expect(
    (await queries.listMembers(db, org.id, { limit: 1 })).map((row) => row.id),
  ).toEqual([ids[1]!, ids[0]!]);
  expect(
    (await queries.listMembers(db, org.id, { limit: 1, cursor: ids[1] })).map(
      (row) => row.id,
    ),
  ).toEqual([ids[0]!]);
  for (const q of ["PERSON0@", "pERson 0"])
    expect(
      (await queries.listMembers(db, org.id, { limit: 10, q })).map(
        (row) => row.id,
      ),
    ).toEqual([ids[0]!]);
  expect(
    await queries.updateMemberWindow(db, org.id, ids[0]!, {
      validFrom: past,
      validUntil: future,
    }),
  ).toMatchObject({ effective: true });
  expect(
    await queries.updateMemberWindow(db, org.id, ids[0]!, {
      validFrom: null,
      validUntil: past,
    }),
  ).toMatchObject({ effective: false });
  expect(
    (
      await queries.listMembers(db, org.id, { limit: 10, effective: false })
    ).map((row) => row.id),
  ).toEqual([ids[0]!]);
  expect(
    (await queries.listMembers(db, org.id, { limit: 10, effective: true })).map(
      (row) => row.id,
    ),
  ).toEqual([ids[1]!]);
  expect(
    await queries.updateMemberWindow(db, org.id, ids[0]!, {
      validFrom: future,
      validUntil: null,
    }),
  ).toMatchObject({ effective: false });
  expect(
    await queries.updateMemberWindow(db, org.id, ids[0]!, { validFrom: null }),
  ).toMatchObject({ effective: true });
  await expect(
    queries.updateMemberWindow(db, org.id, ids[0]!, {
      validFrom: future,
      validUntil: past,
    }),
  ).rejects.toThrow();
  for (const organizationId of [other.id, createId()]) {
    expect(await queries.findMember(db, organizationId, ids[0]!)).toBeNull();
    expect(
      await queries.updateMemberWindow(db, organizationId, ids[0]!, {
        validUntil: null,
      }),
    ).toBeNull();
    expect(await queries.removeMember(db, organizationId, ids[0]!)).toBeNull();
  }
  expect(await queries.removeMember(db, org.id, ids[0]!)).toMatchObject({
    id: ids[0],
    userId: row!.userId,
  });
  expect(await queries.removeMember(db, org.id, ids[0]!)).toBeNull();
  expect(await queries.findMember(db, org.id, ids[0]!)).toBeNull();
  expect(
    await db.select().from(users).where(eq(users.id, row!.userId)),
  ).toHaveLength(1);
});
