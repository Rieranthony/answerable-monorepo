import type {
  TenantMemberContext,
  TenantReadContext,
} from "../../services/tenant-context.ts";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import type { MemberWindow } from "../../__tests__/group-queries.ts";
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
    sql`truncate table security_identifiers, audit_events, organizations, users cascade`,
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
import * as memberQueries from "./members.ts";
import { inTenant, inTenantRead } from "../../__tests__/tenant-command.ts";
import type { Database } from "../client.ts";
const queries = {
  listMembers: (
    db: Database,
    organizationId: string,
    query: memberQueries.MemberQuery,
  ) =>
    inTenantRead(db, organizationId, "directory", (context) =>
      memberQueries.listMembers(context, query),
    ),
  findMember: (db: Database, organizationId: string, memberId: string) =>
    inTenantRead(db, organizationId, "directory", (context) =>
      memberQueries.findMember(context, memberId),
    ),
  updateMemberWindow: (
    db: Database,
    organizationId: string,
    memberId: string,
    patch: MemberWindow,
  ) =>
    inTenant(db, organizationId, (context) =>
      memberQueries.updateMemberWindow(context, memberId, patch),
    ),
  revokeMember: (db: Database, organizationId: string, memberId: string) =>
    inTenant(db, organizationId, (context) =>
      memberQueries.revokeMember(context, memberId),
    ),
  reinstateMember: (db: Database, organizationId: string, memberId: string) =>
    inTenant(db, organizationId, (context) =>
      memberQueries.reinstateMember(context, memberId),
    ),
};
test("membership query entry points reject raw database authority", async () => {
  const { db, org, ids } = await seed();
  for (const [query, args] of [
    [memberQueries.listMembers, [db, org.id, { limit: 10 }]],
    [memberQueries.findMember, [db, org.id, ids[0]!]],
    [memberQueries.findMemberConfiguration, [db, org.id, ids[0]!]],
    [
      memberQueries.updateMemberWindow,
      [db, org.id, ids[0]!, { validUntil: null }],
    ],
    [memberQueries.revokeMember, [db, org.id, ids[0]!]],
    [memberQueries.reinstateMember, [db, org.id, ids[0]!]],
    [memberQueries.removeMemberAssignments, [db, org.id, ids[0]!]],
    [memberQueries.findMemberForAssignment, [db, org.id, ids[0]!]],
  ] as const)
    await expect(
      Promise.resolve().then(() => Reflect.apply(query, undefined, args)),
    ).rejects.toThrow("Invalid or expired");
});
test("member query purposes and lifetimes cannot be widened by direct callers", async () => {
  const { db, org, ids } = await seed();
  const writes = [
    (context: TenantMemberContext) =>
      memberQueries.updateMemberWindow(context, ids[0]!, { validUntil: null }),
    (context: TenantMemberContext) =>
      memberQueries.revokeMember(context, ids[0]!),
    (context: TenantMemberContext) =>
      memberQueries.reinstateMember(context, ids[0]!),
    (context: TenantMemberContext) =>
      memberQueries.removeMemberAssignments(context, ids[0]!),
  ];
  let escaped!: TenantMemberContext;
  await inTenant(db, org.id, async (context) => {
    escaped = context;
    for (const write of writes)
      await expect(write({ ...context })).rejects.toThrow("Invalid or expired");
  });
  for (const write of writes)
    await expect(write(escaped)).rejects.toThrow("Invalid or expired");
  await inTenantRead(db, org.id, "directory", async (context) => {
    expect(() =>
      memberQueries.listMembers({ ...context }, { limit: 1 }),
    ).toThrow("Invalid or expired");
    await expect(
      memberQueries.findMember({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    for (const write of writes)
      await expect(write(context as unknown as typeof escaped)).rejects.toThrow(
        "Invalid or expired",
      );
    await expect(
      Reflect.apply(memberQueries.findMemberConfiguration, undefined, [
        context,
        ids[0]!,
      ]),
    ).rejects.toThrow("Invalid or expired");
  });
  let read!: TenantReadContext<"configuration">;
  await inTenantRead(db, org.id, "configuration", async (context) => {
    read = context;
    expect(
      await memberQueries.findMemberConfiguration(context, ids[0]!),
    ).toMatchObject({ id: ids[0], organizationId: org.id });
    await expect(
      memberQueries.findMemberConfiguration({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      Reflect.apply(memberQueries.findMember, undefined, [context, ids[0]!]),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(
    memberQueries.findMemberConfiguration(read, ids[0]!),
  ).rejects.toThrow("Invalid or expired");
  await expect(
    inTenantRead(db, createId(), "directory", (context) =>
      memberQueries.findMember(context, ids[0]!),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

test("platform assignment lookup returns only membership state and requires live write authority", async () => {
  const { db, org, other, ids } = await seed();
  const { inPlatformWrite } =
    await import("../../__tests__/platform-context.ts");
  let escaped!: PlatformWriteContext;
  await inPlatformWrite(db, async (context) => {
    escaped = context;
    expect(
      await memberQueries.findMemberForAssignment(context, org.id, ids[0]!),
    ).toEqual({ membershipStatus: "active" });
    expect(
      await memberQueries.findMemberForAssignment(context, other.id, ids[0]!),
    ).toBeNull();
    await expect(
      memberQueries.findMemberForAssignment({ ...context }, org.id, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(
    memberQueries.findMemberForAssignment(escaped, org.id, ids[0]!),
  ).rejects.toThrow("Invalid or expired");
});
import { createGroup, addGroupMember } from "../../__tests__/group-queries.ts";
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
  for (const organizationId of [other.id]) {
    expect(await queries.findMember(db, organizationId, ids[0]!)).toBeNull();
    expect(
      await queries.updateMemberWindow(db, organizationId, ids[0]!, {
        validUntil: null,
      }),
    ).toBeNull();
    expect(await queries.revokeMember(db, organizationId, ids[0]!)).toBeNull();
    expect(
      await queries.reinstateMember(db, organizationId, ids[0]!),
    ).toBeNull();
  }
  expect(await queries.revokeMember(db, org.id, ids[0]!)).toMatchObject({
    id: ids[0],
    userId: row!.userId,
  });
  expect(await queries.revokeMember(db, org.id, ids[0]!)).toMatchObject({
    status: "revoked",
  });
  expect(await queries.findMember(db, org.id, ids[0]!)).toMatchObject({
    membershipStatus: "revoked",
    effective: false,
  });
  expect(
    await db.select().from(users).where(eq(users.id, row!.userId)),
  ).toHaveLength(1);
});
