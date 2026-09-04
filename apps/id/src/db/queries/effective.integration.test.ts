import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  entitlements,
  members,
  oauthResources,
  organizations,
  users,
} from "../schema/index.ts";
import { isEffective } from "./effective.ts";

let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});

beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table users, organizations, oauth_resources cascade`,
  );
});

afterAll(async () => {
  await connection.close();
});

test("filters rows by status and effective window", async () => {
  const now = Date.now();
  const day = 86_400_000;
  const [organization] = await connection.db
    .insert(organizations)
    .values({ id: createId(), name: "Example", slug: "example" })
    .returning();
  const entitlementCases = [
    { name: "open", validFrom: null, validUntil: null, status: "active" },
    {
      name: "current",
      validFrom: new Date(now - day),
      validUntil: new Date(now + day),
      status: "active",
    },
    {
      name: "expired",
      validFrom: new Date(now - 2 * day),
      validUntil: new Date(now - day),
      status: "active",
    },
    {
      name: "future",
      validFrom: new Date(now + day),
      validUntil: new Date(now + 2 * day),
      status: "active",
    },
    {
      name: "open-but-disabled",
      validFrom: null,
      validUntil: null,
      status: "disabled",
    },
  ] as const;

  for (const row of entitlementCases) {
    const identifier = `https://${row.name}.example.com`;
    await connection.db.insert(oauthResources).values({
      id: createId(),
      identifier,
      name: row.name,
    });
    await connection.db.insert(entitlements).values({
      id: createId(),
      organizationId: organization!.id,
      resource: identifier,
      scopes: ["tutor:read"],
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      status: row.status,
    });
  }

  const effectiveEntitlements = await connection.db
    .select({ resource: entitlements.resource })
    .from(entitlements)
    .where(isEffective(entitlements));
  expect(effectiveEntitlements.map((row) => row.resource).sort()).toEqual([
    "https://current.example.com",
    "https://open.example.com",
  ]);

  const memberCases = [
    { name: "open", validFrom: null, validUntil: null },
    {
      name: "current",
      validFrom: new Date(now - day),
      validUntil: new Date(now + day),
    },
    {
      name: "expired",
      validFrom: new Date(now - 2 * day),
      validUntil: new Date(now - day),
    },
    {
      name: "future",
      validFrom: new Date(now + day),
      validUntil: new Date(now + 2 * day),
    },
  ] as const;
  const memberNames = new Map<string, string>();

  for (const row of memberCases) {
    const userId = createId();
    await connection.db.insert(users).values({
      id: userId,
      name: row.name,
      email: `${row.name}@example.com`,
      status: "active",
    });
    const memberId = createId();
    memberNames.set(memberId, row.name);
    await connection.db.insert(members).values({
      id: memberId,
      organizationId: organization!.id,
      userId,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
    });
  }

  const effectiveMembers = await connection.db
    .select({ id: members.id })
    .from(members)
    .where(isEffective(members));
  expect(
    effectiveMembers.map((row) => memberNames.get(row.id)).sort(),
  ).toEqual(["current", "open"]);
});
