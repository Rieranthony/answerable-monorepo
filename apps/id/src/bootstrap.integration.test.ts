import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";

import { openRuntimeRole } from "./__tests__/runtime-role.ts";
import { testEnvironment } from "./__tests__/support.ts";
import { assertDisposableTestDatabase } from "./__tests__/test-database.ts";
import {
  bootstrap,
  platformAdminsGroupSlug,
  platformScopes,
  type BootstrapOptions,
} from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import { withDatabaseScope } from "./db/isolation.ts";
import {
  auditEvents,
  entitlements,
  groups,
  oauthResources,
  organizationCapabilities,
  organizations,
} from "./db/schema/index.ts";
import { adminScopes } from "./http/admin/scopes.ts";

const connection = createDatabase(testEnvironment());
const db = connection.db;
const options: BootstrapOptions = {
  platformOrganizationSlug: "answerable",
  platformOrganizationName: "Answerable",
  adminResourceIdentifier: "https://id.answerable.org/api/admin",
};
const actor = {
  actorType: "client" as const,
  actorId: "seed-test",
  requestId: "seed-request",
  ip: "192.0.2.1",
  userAgent: "seed-test-agent",
};

beforeEach(async () => {
  assertDisposableTestDatabase("truncate bootstrap fixtures");
  await db.execute(
    sql`truncate table organizations, users, oauth_resources, oauth_clients, audit_events cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

async function rows() {
  return {
    organization: await db.select().from(organizations),
    resource: await db.select().from(oauthResources),
    group: await db.select().from(groups),
    entitlement: await db.select().from(entitlements),
  };
}

const definition = {
  name: "Answerable ID admin API",
  accessTokenTtl: 600,
  allowedScopes: [...adminScopes],
};

test("the first start provisions the platform; later starts change only the admin resource's definition", async () => {
  const first = await bootstrap(db, actor, options);
  expect(first.created).toBe(true);
  const seeded = await rows();
  for (const table of Object.values(seeded)) expect(table).toHaveLength(1);
  expect(seeded.organization[0]).toMatchObject({
    id: first.organizationId,
    slug: "answerable",
    name: "Answerable",
    status: "active",
  });
  expect(first.slug).toBe("answerable");
  expect(seeded.resource[0]).toMatchObject({
    id: first.resourceId,
    identifier: options.adminResourceIdentifier,
    ...definition,
    disabled: false,
  });
  expect(seeded.group[0]).toMatchObject({
    id: first.groupId,
    organizationId: first.organizationId,
    slug: platformAdminsGroupSlug,
    name: "Platform admins",
    status: "active",
  });
  expect(seeded.entitlement[0]).toMatchObject({
    organizationId: first.organizationId,
    groupId: first.groupId,
    memberId: null,
    clientId: null,
    resource: options.adminResourceIdentifier,
    scopes: platformScopes,
  });
  let audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "bootstrap.applied",
    ...actor,
    organizationId: first.organizationId,
    targetType: "organization",
    targetId: first.organizationId,
    outcome: "success",
    data: {
      created: true,
      resource: { before: null, after: definition },
      capability: {
        id: expect.any(String),
        organizationId: first.organizationId,
        resource: options.adminResourceIdentifier,
        grantKind: "admin_session",
        scopes: [...adminScopes],
        status: "active",
        revision: 1,
      },
    },
  });

  // A start that changes nothing records nothing.
  const second = await bootstrap(db, actor, options);
  expect(second).toEqual({ ...first, created: false });
  expect(await rows()).toEqual(seeded);
  expect(await db.select().from(auditEvents)).toHaveLength(1);

  // Operators own the organisation, the group and the entitlement after the
  // first start; the admin resource's definition stays the code's.
  await db
    .update(oauthResources)
    .set({ accessTokenTtl: 42, name: "Drift", allowedScopes: [] })
    .where(eq(oauthResources.id, first.resourceId));
  await db
    .update(entitlements)
    .set({ scopes: ["platform:read"] })
    .where(eq(entitlements.groupId, first.groupId));
  await db
    .update(groups)
    .set({ name: "Staff" })
    .where(eq(groups.id, first.groupId));
  const third = await bootstrap(db, actor, {
    ...options,
    platformOrganizationName: "Answerable platform",
  });
  expect(third).toEqual({ ...first, created: false });
  const after = await rows();
  expect(after.organization[0]!.name).toBe("Answerable");
  expect(after.group[0]!.name).toBe("Staff");
  expect(after.entitlement[0]!.scopes).toEqual(["platform:read"]);
  expect(after.resource[0]).toMatchObject(definition);
  audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(2);
  expect(audit[1]!.data).toEqual({
    created: false,
    resource: {
      before: { name: "Drift", accessTokenTtl: 42, allowedScopes: [] },
      after: definition,
    },
    capability: null,
  });
});

test("concurrent first starts seed and bind one platform", async () => {
  const replicas = createDatabase(testEnvironment({ databasePoolMax: 2 }));
  try {
    const seeds = await Promise.all([
      bootstrap(replicas.db, actor, options),
      bootstrap(replicas.db, actor, options),
    ]);
    expect(seeds[1]!.organizationId).toBe(seeds[0]!.organizationId);
    expect(seeds.map(({ created }) => created).sort()).toEqual([false, true]);
    for (const table of Object.values(await rows()))
      expect(table).toHaveLength(1);
  } finally {
    await replicas.close();
  }
});

test("rolls back the organisation when the resource insert fails", async () => {
  await expect(
    bootstrap(db, actor, {
      ...options,
      adminResourceIdentifier: null as unknown as string,
    }),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("rolls back every seeded row when the audit insert fails", async () => {
  await expect(
    bootstrap(
      db,
      { ...actor, actorType: "invalid" as typeof actor.actorType },
      options,
    ),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("bootstrap does not adopt pre-existing names without a system binding", async () => {
  await db.insert(organizations).values({
    id: crypto.randomUUID(),
    slug: options.platformOrganizationSlug,
    name: "Unrelated tenant",
  });
  await expect(bootstrap(db, actor, options)).rejects.toMatchObject({
    code: "system_binding_conflict",
  });
  expect(await db.select().from(groups)).toHaveLength(0);
});

test("changing the configured slug cannot designate another organisation as the platform", async () => {
  const first = await bootstrap(db, actor, options);
  const otherId = crypto.randomUUID();
  await db
    .insert(organizations)
    .values({ id: otherId, slug: "other-tenant", name: "Other" });
  const next = await bootstrap(db, actor, {
    ...options,
    platformOrganizationSlug: "other-tenant",
  });
  expect(next.organizationId).toBe(first.organizationId);
  expect(next.groupId).toBe(first.groupId);
});

test("bootstrap does not adopt an unrelated existing resource", async () => {
  await db.insert(oauthResources).values({
    id: crypto.randomUUID(),
    identifier: options.adminResourceIdentifier,
    name: "Unrelated",
  });
  await expect(bootstrap(db, actor, options)).rejects.toMatchObject({
    code: "system_binding_conflict",
  });
  expect(await db.select().from(organizations)).toHaveLength(0);
});

test("system binding protects its rows and rejects a changed admin audience", async () => {
  const connections = await openRuntimeRole(testEnvironment());
  try {
    const bound = await bootstrap(db, actor, options);
    await expect(
      bootstrap(db, actor, {
        ...options,
        adminResourceIdentifier: "https://other.example/admin",
      }),
    ).rejects.toMatchObject({ code: "system_binding_conflict" });
    for (const table of [organizations, oauthResources, groups])
      await expect(db.delete(table).execute()).rejects.toThrow();
    // The runtime role may neither rewrite nor remove the binding.
    for (const command of [
      sql`delete from system_bindings`,
      sql`update system_bindings set group_id = ${bound.groupId}`,
    ])
      await expect(
        Promise.resolve(connections.runtime.db.execute(command)),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    // Nor soft-delete what it binds, even after removing every other reference.
    const softDelete = (statements: SQL[]) =>
      withDatabaseScope(
        connections.runtime.db,
        { kind: "platform", access: "write" },
        async (tx) => {
          for (const statement of statements) await tx.execute(statement);
        },
      );
    const retire = sql`deleted_at = now(), status = 'disabled'`;
    await expect(
      softDelete([
        sql`update entitlements set ${retire} where group_id = ${bound.groupId}`,
        sql`update groups set ${retire} where id = ${bound.groupId}`,
      ]),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "system_bindings_group_live_fk" },
    });
    await expect(
      softDelete([
        sql`update entitlements set ${retire} where resource = ${options.adminResourceIdentifier}`,
        sql`update organization_capabilities set ${retire} where resource = ${options.adminResourceIdentifier}`,
        sql`update oauth_resources set deleted_at = now(), disabled = true where id = ${bound.resourceId}`,
      ]),
    ).rejects.toMatchObject({
      cause: {
        code: "23503",
        constraint: "system_bindings_resource_instance_live_fk",
      },
    });
  } finally {
    await connections.close();
  }
});

test("bootstrap preserves explicit restrictions on the bound platform capability", async () => {
  await bootstrap(db, actor, options);
  const [row] = await db
    .update(organizationCapabilities)
    .set({
      status: "disabled",
      scopes: ["platform:read"],
      validUntil: new Date("2000-01-01"),
    })
    .returning();
  await bootstrap(db, actor, options);
  expect(await db.select().from(organizationCapabilities)).toEqual([row!]);
});

test("a removed platform capability stays removed", async () => {
  await bootstrap(db, actor, options);
  await db
    .update(organizationCapabilities)
    .set({ deletedAt: sql`now()`, status: "disabled" });
  await bootstrap(db, actor, options);
  const capabilities = await db.select().from(organizationCapabilities);
  expect(capabilities).toHaveLength(1);
  expect(capabilities[0]!.deletedAt).not.toBeNull();
});
