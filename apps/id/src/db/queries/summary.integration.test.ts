import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { platformAdminsGroupSlug } from "../../bootstrap.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  auditEvents,
  entitlements,
  groups,
  members,
  oauthClients,
  oauthResources,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
  systemBindings,
} from "../schema/index.ts";
import * as queries from "./summary.ts";
import { inPlatformRead } from "../../__tests__/platform-context.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
import type { Database } from "../client.ts";

const platformSummary = (db: Database, options: { now: Date }) =>
  inPlatformRead(db, (context) => queries.platformSummary(context, options));
const organizationSummary = (
  db: Database,
  organizationId: string,
  options: { now: Date },
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.organizationSummary(context, options),
  );
const signInStats = (
  db: Database,
  options: { since: Date; organizationId?: string },
) =>
  options.organizationId === undefined
    ? inPlatformRead(db, (context) =>
        queries.platformSignInStats(context, options),
      )
    : inTenantRead(db, options.organizationId, "directory", (context) =>
        queries.organizationSignInStats(context, options),
      );

let connection: DatabaseConnection;
const now = new Date("2026-09-07T12:00:00Z");
const day = 86_400_000;
const since = new Date(now.getTime() - day);
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
test("summary query rejects a raw database handle", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(queries.platformSummary, undefined, [
        connection.db,
        { now },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("summary preserves exact client-resource pairs separately from standalone targets", async () => {
  const db = connection.db;
  const organizationId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: "pairs", name: "Pairs" });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "pair-client", redirectUris: [] });
  const resources = ["https://first.example", "https://second.example"];
  for (const identifier of resources)
    await db
      .insert(oauthResources)
      .values({ id: createId(), identifier, name: "Pair target" });
  for (const target of [
    { clientId: "pair-client" },
    { resource: resources[0]! },
    ...resources.map((resource) => ({ clientId: "pair-client", resource })),
  ])
    await db
      .insert(entitlements)
      .values({ id: createId(), organizationId, scopes: ["read"], ...target });
  const summary = await organizationSummary(db, organizationId, { now });
  expect(summary.entitlements).toEqual({
    active: 4,
    disabled: 0,
    targets: [
      {
        kind: "client_resource",
        id: "pair-client",
        resource: resources[0],
        rows: 1,
      },
      {
        kind: "client_resource",
        id: "pair-client",
        resource: resources[1],
        rows: 1,
      },
      { kind: "client", id: "pair-client", rows: 1 },
      { kind: "resource", id: resources[0], rows: 1 },
    ],
  });
});

test("empty tables return zero counters, absent platform ids and no sign-ins", async () => {
  expect(
    await platformSummary(connection.db, {
      now,
    }),
  ).toEqual({
    platform: { organizationId: null, groupId: null },
    organizations: { active: 0, disabled: 0 },
    users: { inert: 0, active: 0, disabled: 0 },
    clients: { total: 0, disabled: 0, unowned: 0 },
    resources: { total: 0, disabled: 0 },
    sessions: { active: 0 },
    denied24h: 0,
  });
  await expect(
    organizationSummary(connection.db, createId(), { now }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await signInStats(connection.db, { since })).toEqual({
    succeeded: 0,
    rejected: 0,
    rejectedByReason: {},
    lastSucceededAt: null,
  });
});

test("counts every state, isolates organisations and applies exact membership and session boundaries", async () => {
  const db = connection.db;
  const organizationId = createId();
  const other = createId();
  await db.insert(organizations).values([
    { id: organizationId, name: "Platform", slug: "platform" },
    {
      id: other,
      name: "Other",
      slug: "other",
      status: "disabled",
      disabledAt: now,
    },
  ]);
  expect((await platformSummary(db, { now })).platform).toEqual({
    organizationId: null,
    groupId: null,
  });
  const groupId = createId();
  await db.insert(groups).values([
    {
      id: groupId,
      organizationId,
      name: "Admins",
      slug: platformAdminsGroupSlug,
    },
    {
      id: createId(),
      organizationId,
      name: "Disabled",
      slug: "disabled",
      status: "disabled",
    },
    {
      id: createId(),
      organizationId: other,
      name: "Other",
      slug: platformAdminsGroupSlug,
    },
  ]);
  const cases = [
    { status: "active", validFrom: null, validUntil: null },
    {
      status: "active",
      validFrom: now,
      validUntil: new Date(now.getTime() + day),
    },
    { status: "active", validFrom: null, validUntil: now },
    {
      status: "active",
      validFrom: new Date(now.getTime() + 1),
      validUntil: null,
    },
    { status: "inert", validFrom: null, validUntil: null },
    { status: "disabled", validFrom: null, validUntil: null },
  ] as const;
  const memberIds: string[] = [];
  for (const row of cases) {
    const userId = createId();
    const memberId = createId();
    memberIds.push(memberId);
    await db.insert(users).values({
      id: userId,
      name: "User",
      email: userId + "@example.com",
      status: row.status,
      disabledAt: row.status === "disabled" ? now : null,
    });
    await db.insert(members).values({
      id: memberId,
      userId,
      organizationId,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
    });
    // A second membership must not duplicate sessions in the platform count.
    await db
      .insert(members)
      .values({ id: createId(), userId, organizationId: other });
    for (const expiresAt of [
      now,
      new Date(now.getTime() - 1),
      new Date(now.getTime() + 1),
    ])
      await db.insert(sessions).values({
        id: createId(),
        token: createId(),
        userId,
        activeOrganizationId: other,
        expiresAt,
      });
  }
  const outsiderUser = createId();
  await db.insert(users).values({
    id: outsiderUser,
    name: "Outsider",
    email: "outsider@example.com",
  });
  await db.insert(sessions).values({
    id: createId(),
    token: createId(),
    userId: outsiderUser,
    expiresAt: new Date(now.getTime() + day),
  });
  for (const [index, org] of [
    organizationId,
    organizationId,
    other,
  ].entries()) {
    await db.insert(organizationDomains).values({
      id: createId(),
      organizationId: org,
      domain: `domain${index}.example.com`,
      status: index === 1 ? "disabled" : "active",
    });
  }
  await db.insert(ssoProviders).values({
    id: createId(),
    organizationId,
    issuer: "https://accounts.google.com",
    providerId: "platform",
    domain: "domain0.example.com",
  });
  await db.insert(oauthClients).values([
    { id: createId(), clientId: "owned", organizationId, redirectUris: [] },
    {
      id: createId(),
      clientId: "disabled",
      organizationId,
      redirectUris: [],
      disabled: true,
    },
    { id: createId(), clientId: "unowned", redirectUris: [] },
    {
      id: createId(),
      clientId: "other",
      organizationId: other,
      redirectUris: [],
    },
  ]);
  await db.insert(oauthResources).values([
    {
      id: createId(),
      identifier: "https://resource.example.com",
      name: "Resource",
    },
    {
      id: createId(),
      identifier: "https://disabled.example.com",
      name: "Disabled",
      disabled: true,
    },
  ]);
  const [adminResource] = await db.select().from(oauthResources);
  await db.insert(systemBindings).values({
    name: "platform",
    organizationId,
    groupId,
    resourceId: adminResource!.id,
  });
  await db.insert(entitlements).values([
    {
      id: createId(),
      organizationId,
      clientId: "owned",
      scopes: ["read"],
      validUntil: since,
    },
    {
      id: createId(),
      organizationId,
      memberId: memberIds[0]!,
      clientId: "owned",
      scopes: ["read"],
      status: "disabled",
    },
    {
      id: createId(),
      organizationId,
      resource: "https://resource.example.com",
      scopes: ["read"],
      validFrom: new Date(now.getTime() + day),
    },
    {
      id: createId(),
      organizationId: other,
      clientId: "other",
      scopes: ["read"],
    },
  ]);
  const summary = await organizationSummary(db, organizationId, { now });
  expect(summary).toMatchObject({
    organization: { id: organizationId },
    domains: { active: 1, disabled: 1 },
    provider: { issuer: "https://accounts.google.com" },
    members: {
      total: 6,
      effective: 4,
      byStatus: { inert: 1, active: 4, disabled: 1 },
    },
    groups: { active: 1, disabled: 1 },
    entitlements: {
      active: 2,
      disabled: 1,
      targets: [
        { kind: "client", id: "owned", rows: 2 },
        { kind: "resource", id: "https://resource.example.com", rows: 1 },
      ],
    },
    clients: { owned: 2 },
  });
  expect(await platformSummary(db, { now })).toEqual({
    platform: { organizationId, groupId },
    organizations: { active: 1, disabled: 1 },
    users: { inert: 2, active: 4, disabled: 1 },
    clients: { total: 4, disabled: 1, unowned: 1 },
    resources: { total: 2, disabled: 1 },
    sessions: { active: 7 },
    denied24h: 0,
  });
});

test("sign-in stats filter time and organisation, count rejection reasons and ignore other actions", async () => {
  const db = connection.db;
  const organizationId = createId();
  const other = createId();
  await db.insert(organizations).values([
    { id: organizationId, slug: "platform", name: "Platform" },
    { id: other, slug: "other", name: "Other" },
  ]);
  const events = [
    {
      action: "auth.signin.succeeded",
      organizationId,
      occurredAt: since,
      reason: "first",
    },
    { action: "auth.signin.succeeded", organizationId, occurredAt: now },
    { action: "auth.signin.succeeded", organizationId: other, occurredAt: now },
    {
      action: "auth.signin.succeeded",
      organizationId,
      occurredAt: new Date(since.getTime() - 1),
    },
    {
      action: "auth.signin.rejected",
      reason: "unknown_domain",
      occurredAt: since,
    },
    {
      action: "auth.signin.rejected",
      reason: "unknown_domain",
      occurredAt: now,
    },
    {
      action: "auth.signin.rejected",
      reason: "user_disabled",
      occurredAt: now,
    },
    { action: "auth.signin.rejected", reason: "__proto__", occurredAt: now },
    { action: "auth.signin.rejected", occurredAt: now },
    {
      action: "auth.signin.rejected",
      reason: "old",
      occurredAt: new Date(since.getTime() - 1),
    },
    { action: "auth.signout", organizationId, occurredAt: now },
    { action: "admin.denied", occurredAt: since },
    { action: "admin.denied", organizationId, occurredAt: now },
    { action: "admin.denied", occurredAt: new Date(since.getTime() - 1) },
    { action: "admin.root_request", occurredAt: now },
    { action: "organization.created", organizationId, occurredAt: now },
  ];
  for (const event of events)
    await db.insert(auditEvents).values({
      id: createId(),
      actorType: "system",
      actorId: "test",
      targetType: "test",
      outcome:
        event.action === "auth.signin.rejected"
          ? "failure"
          : event.action === "admin.denied"
            ? "denied"
            : "success",
      ...event,
    });
  expect(await signInStats(db, { since })).toEqual({
    succeeded: 3,
    rejected: 5,
    rejectedByReason: { unknown_domain: 2, user_disabled: 1, ["__proto__"]: 1 },
    lastSucceededAt: now,
  });
  expect(await signInStats(db, { since, organizationId })).toEqual({
    succeeded: 2,
    rejected: 0,
    rejectedByReason: {},
    lastSucceededAt: now,
  });
  expect(
    await signInStats(db, {
      since: new Date(now.getTime() + 1),
      organizationId,
    }),
  ).toEqual({
    succeeded: 0,
    rejected: 0,
    rejectedByReason: {},
    lastSucceededAt: null,
  });
  expect((await platformSummary(db, { now })).denied24h).toBe(2);
});

test("all summary queries reject copied, expired and wrong-purpose contexts", async () => {
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "context", name: "Context" });
  const platformQueries = [
    queries.platformSummary,
    queries.platformSignInStats,
  ];
  const tenantQueries = [
    queries.organizationSummary,
    queries.organizationSignInStats,
  ];
  const options = { now, since };
  async function rejects(
    functions: ((...args: never[]) => unknown)[],
    context: unknown,
  ) {
    for (const fn of functions)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(fn, undefined, [context, options]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  let expired: unknown;
  await inPlatformRead(connection.db, async (context) => {
    expired = context;
    await rejects(platformQueries, { ...context });
    await rejects(tenantQueries, context);
  });
  await rejects(platformQueries, expired);
  await rejects(platformQueries, connection.db);
  await rejects(tenantQueries, connection.db);
  await inTenantRead(
    connection.db,
    organizationId,
    "directory",
    async (context) => {
      expired = context;
      await rejects(tenantQueries, { ...context });
      await rejects(platformQueries, context);
    },
  );
  await rejects(tenantQueries, expired);
  for (const access of ["configuration", "memberAccess", "history"] as const)
    await inTenantRead(connection.db, organizationId, access, (context) =>
      rejects(tenantQueries, context),
    );
});
