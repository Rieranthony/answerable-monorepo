import { inPlatformRead } from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  organizations,
  ssoProviders,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  getOrganizationSummary as readOrganizationSummary,
  getPlatformSummary as readPlatformSummary,
} from "./summary.ts";

let connection: DatabaseConnection;
const environment = testEnvironment();
beforeAll(() => {
  connection = createDatabase(environment);
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

test("missing organisation is 404 and empty fleet has the public shape", async () => {
  await expect(
    getOrganizationSummary(connection.db, createId()),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await getPlatformSummary(connection.db)).toEqual({
    platform: { organizationId: null, groupId: null },
    organizations: { active: 0, disabled: 0 },
    users: { inert: 0, active: 0, disabled: 0 },
    clients: { total: 0, disabled: 0, unowned: 0 },
    resources: { total: 0, disabled: 0 },
    sessions: { active: 0 },
    signIns24h: { succeeded: 0, rejected: 0, rejectedByReason: {} },
    denied24h: 0,
  });
  expect(await connection.db.select().from(auditEvents)).toEqual([]);
});

test("organisation shape preserves the row and reports absent configuration", async () => {
  const [organization] = await connection.db
    .insert(organizations)
    .values({ id: createId(), slug: "empty", name: "Empty", metadata: "{}" })
    .returning();
  expect(await getOrganizationSummary(connection.db, organization!.id)).toEqual(
    {
      organization,
      domains: { active: 0, disabled: 0 },
      ssoProvider: { configured: false, kind: null, issuer: null },
      members: {
        total: 0,
        effective: 0,
        byStatus: { inert: 0, active: 0, disabled: 0 },
      },
      groups: { active: 0, disabled: 0 },
      entitlements: { active: 0, disabled: 0, targets: [] },
      clients: { owned: 0 },
      signIns7d: { succeeded: 0, lastSucceededAt: null },
    },
  );
});

test("classifies configured issuers and uses distinct seven-day and 24-hour windows without writing", async () => {
  const db = connection.db;
  const recent = new Date(Date.now() - 60_000);
  const twoDays = new Date(Date.now() - 2 * 86_400_000);
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (const [kind, issuer] of [
    [
      "entra",
      "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
    ],
    ["google", "https://accounts.google.com"],
    ["oidc", "https://issuer.example.com"],
  ] as const) {
    const organizationId = createId();
    await db
      .insert(organizations)
      .values({ id: organizationId, name: kind, slug: kind });
    await db.insert(ssoProviders).values({
      id: createId(),
      organizationId,
      issuer,
      providerId: kind,
      domain: kind + ".example.com",
    });
    for (const occurredAt of [recent, twoDays, old])
      await db.insert(auditEvents).values({
        id: createId(),
        organizationId,
        occurredAt,
        action: "auth.signin.succeeded",
        actorType: "system",
        actorId: "test",
        targetType: "user",
        outcome: "success",
      });
    const summary = await getOrganizationSummary(db, organizationId);
    expect(summary.ssoProvider).toEqual({ configured: true, kind, issuer });
    expect(summary.signIns7d).toEqual({
      succeeded: 2,
      lastSucceededAt: recent,
    });
  }
  for (const occurredAt of [recent, twoDays, old])
    await db.insert(auditEvents).values({
      id: createId(),
      occurredAt,
      action: "auth.signin.rejected",
      reason: "unknown_domain",
      actorType: "system",
      actorId: "test",
      targetType: "user",
      outcome: "failure",
    });
  const before = await db.select().from(auditEvents);
  expect((await getPlatformSummary(db)).signIns24h).toEqual({
    succeeded: 3,
    rejected: 1,
    rejectedByReason: { unknown_domain: 1 },
  });
  expect(await db.select().from(auditEvents)).toEqual(before);
});

const getOrganizationSummary = (db: Database, org: string) =>
  inTenantRead(db, org, "directory", readOrganizationSummary);

const getPlatformSummary = (db: Database) =>
  inPlatformRead(db, readPlatformSummary);
