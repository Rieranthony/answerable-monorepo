import { withDatabaseScope } from "./isolation.ts";
import {
  approveAdminCapability,
  approveMachineCapability,
} from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import {
  createClient as createClientImplementation,
  linkResource as linkResourceImplementation,
} from "../services/clients.ts";
const createClient = platformWriteService(createClientImplementation);
const linkResource = platformWriteService(linkResourceImplementation);
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { auditEvents } from "./schema/index.ts";
import { configureRuntimeRole, assertRuntimeRole } from "./runtime-role.ts";

let owner: DatabaseConnection;
let runtime: DatabaseConnection;
const roleName = `id_test_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
const ownerRole = `id_test_owner_${crypto.randomUUID().replaceAll("-", "")}`;
const environment = testEnvironment();
beforeAll(async () => {
  assertDisposableTestDatabase("runtime role proof");
  owner = createDatabase(environment);
  await owner.db.execute(
    sql`truncate audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
  await configureRuntimeRole(owner.db, roleName);
  const password = crypto.randomUUID().replaceAll("-", "");
  await owner.db.execute(
    sql.raw(`alter role "${roleName}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = roleName;
  url.password = password;
  runtime = createDatabase({
    ...environment,
    databaseUrl: url.toString(),
    databasePoolMax: 2,
  });
});
afterAll(async () => {
  await runtime?.close();
  await owner.db.execute(sql`drop owned by ${sql.identifier(roleName)}`);
  await owner.db.execute(sql`drop role ${sql.identifier(roleName)}`);
  await owner.close();
});

test("real runtime login can bootstrap, audit and issue a machine token", async () => {
  await configureRuntimeRole(owner.db, roleName);
  await assertRuntimeRole(runtime.db);
  await expect(assertRuntimeRole(owner.db)).rejects.toThrow(
    "Unsafe database runtime role",
  );
  const identity = await runtime.db.execute(sql`select current_user as name`);
  expect(identity.rows).toEqual([{ name: roleName }]);
  const actor = systemActor("runtime-role-test");
  const seeded = await bootstrap(runtime.db, actor, {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Platform",
    adminResourceIdentifier: environment.adminResourceIdentifier,
  });
  const client = await createClient(runtime.db, actor, {
    clientId: "runtime-machine",
    name: "Runtime",
    organizationId: seeded.organization.id,
    grantTypes: ["client_credentials"],
    redirectUris: [],
    tokenEndpointAuthMethod: "client_secret_basic",
    clientCredentialsScopes: ["platform:read"],
  });
  await linkResource(
    runtime.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  await approveMachineCapability(owner.db, {
    organizationId: seeded.organization.id,
    clientId: client.clientId,
    resource: environment.adminResourceIdentifier,
    scopes: ["platform:read"],
  });
  const app = createApp({
    auth: createAuth(runtime.db, environment),
    db: runtime.db,
    environment,
  });
  const response = await app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: environment.adminResourceIdentifier,
      scope: "platform:read",
    }),
  });
  expect(response.status).toBe(200);
  const token = (await response.json()).access_token;
  expect(
    (
      await app.request("/api/admin/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "platform", access: "read" },
      (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "oauth.token.issued")),
    ),
  ).toMatchObject([
    {
      actorType: "client",
      actorId: client.clientId,
      outcome: "success",
      schemaVersion: 2,
      data: {
        decision: {
          allowed: true,
          reason: "approved",
          grantType: "client_credentials",
          subjectType: "client",
          organization: { id: seeded.organization.id },
          client: { clientId: client.clientId },
          resource: { identifier: environment.adminResourceIdentifier },
          requestedScopes: ["platform:read"],
          scopes: ["platform:read"],
          evidence: {
            policyVersion: 1,
            capabilities: [
              { grantKind: "client_credentials", scopes: ["platform:read"] },
            ],
          },
        },
      },
    },
  ]);
  const denied = await app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: environment.adminResourceIdentifier,
      scope: "platform:write",
    }),
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "invalid_scope" });
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "platform", access: "read" },
      (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "oauth.token.rejected")),
    ),
  ).toMatchObject([
    {
      actorType: "client",
      actorId: client.clientId,
      organizationId: seeded.organization.id,
      outcome: "denied",
      reason: "invalid_scope",
      data: { stage: "authorization" },
    },
  ]);
});

test("runtime cannot mutate evidence, forge subjects, truncate, alter schema or assume an owner", async () => {
  for (const command of [
    "update audit_events set action = 'forged'",
    "delete from audit_events",
    "delete from admin_operations",
    "update admin_operations set outcome = 'noop'",
    "truncate admin_operations",
    "update admin_operation_results set ciphertext = 'forged'",
    "delete from admin_operation_results",
    "truncate admin_operation_results",
    "truncate audit_events cascade",
    "delete from audit_event_subjects",
    "insert into audit_event_subjects select * from audit_event_subjects",
    "alter table audit_events disable trigger all",
    "create table public.runtime_forgery (id int)",
    "select capture_audit_subjects(event, 'recorded') from audit_events event limit 1",
    "select public.purge_operation_results('00000000-0000-7000-8000-000000000001'::uuid, 1)",
    "set role answerable",
  ])
    await expect(
      Promise.resolve(runtime.db.execute(sql.raw(command))),
    ).rejects.toThrow();
});

test("provisioning rejects invalid names, privileged roles and object owners", async () => {
  expect(() => configureRuntimeRole(owner.db, "bad; role")).toThrow(
    "Invalid runtime role name",
  );
  await owner.db.execute(
    sql`create role ${sql.identifier(ownerRole)} nologin createdb`,
  );
  try {
    await expect(configureRuntimeRole(owner.db, ownerRole)).rejects.toThrow(
      "privileged attributes",
    );
    await owner.db.execute(
      sql`alter role ${sql.identifier(ownerRole)} nocreatedb`,
    );
    await owner.db.execute(
      sql`create table public.runtime_owner_probe (id integer)`,
    );
    await owner.db.execute(
      sql`alter table public.runtime_owner_probe owner to ${sql.identifier(ownerRole)}`,
    );
    await expect(configureRuntimeRole(owner.db, ownerRole)).rejects.toThrow(
      "must not own",
    );
  } finally {
    await owner.db.execute(sql`drop owned by ${sql.identifier(ownerRole)}`);
    await owner.db.execute(sql`drop role ${sql.identifier(ownerRole)}`);
  }
});

test("RLS denies missing/read-only context and isolates concurrent tenants on the real runtime role", async () => {
  const { createId } = await import("../lib/id.ts");
  const { setDatabaseScope, withDatabaseScope } =
    await import("./isolation.ts");
  const { createOrganization } =
    await import("../__tests__/organization-queries.ts");
  const { users, members, groups, groupMembers, entitlements } =
    await import("./schema/index.ts");
  const tenants = [];
  for (const slug of ["rls-alpha", "rls-beta"]) {
    const org = await createOrganization(owner.db, { slug, name: slug });
    const userId = createId(),
      memberId = createId(),
      groupId = createId();
    await owner.db.insert(users).values({
      id: userId,
      email: `${slug}@example.com`,
      name: slug,
      status: "active",
    });
    await owner.db
      .insert(members)
      .values({ id: memberId, organizationId: org.id, userId });
    await owner.db.insert(groups).values({
      id: groupId,
      organizationId: org.id,
      slug: "team",
      name: "Team",
    });
    await owner.db
      .insert(groupMembers)
      .values({ id: createId(), organizationId: org.id, groupId, memberId });
    await owner.db.insert(entitlements).values({
      id: createId(),
      organizationId: org.id,
      groupId,
      resource: environment.adminResourceIdentifier,
      scopes: ["org:read"],
    });
    await approveAdminCapability(owner.db, {
      organizationId: org.id,
      resource: environment.adminResourceIdentifier,
      scopes: ["org:read"],
    });
    tenants.push({ id: org.id, userId, memberId, groupId });
  }
  const [a, b] = tenants as [
    (typeof tenants)[number],
    (typeof tenants)[number],
  ];
  const foreignGroupId = createId();
  await owner.db.insert(groups).values({
    id: foreignGroupId,
    organizationId: b.id,
    slug: "other",
    name: "Other",
  });
  const foreignInserts = [
    (tx: import("./client.ts").Executor) =>
      tx.insert(groups).values({
        id: createId(),
        organizationId: b.id,
        slug: createId(),
        name: "Foreign",
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(groupMembers).values({
        id: createId(),
        organizationId: b.id,
        groupId: foreignGroupId,
        memberId: b.memberId,
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(entitlements).values({
        id: createId(),
        organizationId: b.id,
        groupId: foreignGroupId,
        resource: environment.adminResourceIdentifier,
        scopes: ["org:read"],
      }),
  ];
  for (const insert of foreignInserts)
    await expect(Promise.resolve(insert(runtime.db))).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/^(42501|23503)$/) },
    });
  const tables = ["groups", "group_members", "entitlements"];
  const rows = (tx: import("./client.ts").Executor, table: string) =>
    tx.execute<{ organization_id: string }>(
      sql`select distinct organization_id from ${sql.identifier(table)}`,
    );
  for (const table of tables) {
    expect((await rows(runtime.db, table)).rows).toEqual([]);
    await expect(
      Promise.resolve(
        runtime.db.execute(
          sql`delete from ${sql.identifier(table)} returning organization_id`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  }
  const { inPlatformUsers } = await import("../__tests__/platform-context.ts");
  await inPlatformUsers(runtime.db, async (context) => {
    for (const table of tables)
      expect((await rows(context.tx, table)).rows).toEqual([]);
  });
  const insert = (tx: import("./client.ts").Executor, organizationId: string) =>
    tx.execute(
      sql`insert into groups(id, organization_id, slug, name) values (${createId()}, ${organizationId}, ${createId()}, 'RLS probe') returning id`,
    );
  await expect(Promise.resolve(insert(runtime.db, a.id))).rejects.toThrow();
  await runtime.db.transaction(async (tx) => {
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "read",
      organizationId: a.id,
    });
    for (const table of tables)
      expect((await rows(tx, table)).rows).toEqual([{ organization_id: a.id }]);
    expect(
      (await tx.execute(sql`update groups set name = 'forbidden' returning id`))
        .rows,
    ).toEqual([]);
    await expect(
      tx.transaction(async (nested) => insert(nested, a.id)),
    ).rejects.toThrow();
  });
  await runtime.db.transaction(async (tx) => {
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "write",
      organizationId: a.id,
    });
    expect(
      (
        await tx.execute(
          sql`update groups set name = 'Own tenant' returning organization_id`,
        )
      ).rows,
    ).toEqual([{ organization_id: a.id }]);
    await expect(
      tx.transaction((nested) =>
        nested.execute(
          sql`delete from groups where organization_id = ${b.id} returning id`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      tx.transaction(async (nested) => insert(nested, b.id)),
    ).rejects.toThrow();
    for (const insert of foreignInserts)
      await expect(
        tx.transaction(async (nested) => insert(nested)),
      ).rejects.toMatchObject({
        cause: { code: expect.stringMatching(/^(42501|23503)$/) },
      });
    await withDatabaseScope(
      tx,
      { kind: "policy-user", userId: b.userId },
      async (policy) => {
        for (const table of tables)
          expect((await rows(policy, table)).rows).toEqual([
            { organization_id: b.id },
          ]);
        await expect(
          policy.transaction((nested) =>
            nested.execute(sql`delete from groups returning id`),
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
      },
    );
    expect((await rows(tx, "groups")).rows).toEqual([
      { organization_id: a.id },
    ]);
    await expect(
      withDatabaseScope(
        tx,
        { kind: "policy-user", userId: b.userId },
        async () => {
          throw new Error("policy rollback");
        },
      ),
    ).rejects.toThrow("policy rollback");
    expect((await rows(tx, "groups")).rows).toEqual([
      { organization_id: a.id },
    ]);
  });
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await Promise.all(
      tenants.map((tenant) =>
        runtime.db.transaction(async (tx) => {
          await setDatabaseScope(tx, {
            kind: "tenant",
            access: "read",
            organizationId: tenant.id,
          });
          if (++entered === 2) release();
          await both;
          for (const table of tables)
            expect((await rows(tx, table)).rows).toEqual([
              { organization_id: tenant.id },
            ]);
        }),
      ),
    );
  } finally {
    release();
  }
  await expect(
    runtime.db.transaction(async (tx) => {
      await setDatabaseScope(tx, { kind: "platform", access: "write" });
      throw new Error("rollback platform scope");
    }),
  ).rejects.toThrow("rollback platform scope");
  for (const table of tables)
    expect((await rows(runtime.db, table)).rows).toEqual([]);
  const reusedConnections = await Promise.all(
    [0, 1].map(() =>
      runtime.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        for (const table of tables)
          expect((await rows(tx, table)).rows).toEqual([]);
        return pid.rows[0]!.pid;
      }),
    ),
  );
  expect(new Set(reusedConnections).size).toBe(2);
  const { effectiveGrants, hasPlatformWriter } =
    await import("./queries/grants.ts");
  expect(
    await effectiveGrants(
      runtime.db,
      { userId: a.userId },
      environment.adminResourceIdentifier,
    ),
  ).toMatchObject([{ organizationId: a.id, scopes: ["org:read"] }]);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: environment.adminResourceIdentifier,
    }),
  ).toBe(false);
  await withDatabaseScope(runtime.db, { kind: "policy-root" }, async (tx) => {
    const binding = await owner.db.execute<{ organization_id: string }>(
      sql`select organization_id from system_bindings`,
    );
    expect((await rows(tx, "groups")).rows).toEqual(binding.rows);
  });
});

test("installed auth adapter and current tenant/platform read contexts work under the runtime role", async () => {
  const { createAdminFixture } = await import("../__tests__/admin.ts");
  const fixture = await createAdminFixture();
  const { groups } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const groupId = createId();
  await fixture.db.insert(groups).values({
    id: groupId,
    organizationId: fixture.tenant.organizationId,
    slug: "runtime-read",
    name: "Runtime read",
  });
  try {
    const app = createApp({
      db: runtime.db,
      environment: fixture.environment,
      auth: createAuth(runtime.db, fixture.environment),
    });
    for (const principal of ["tenantReader", "platformReader"] as const) {
      const response = await app.request(
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups`,
        { headers: fixture.headers(principal) },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).items).toMatchObject([{ id: groupId }]);
    }
    expect(
      (
        await app.request(
          `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
          { headers: fixture.headers("tenantReader") },
        )
      ).status,
    ).toBe(404);
    const disabled = await app.request(
      `/api/admin/v1/users/${fixture.principals.tenantReader.userId}/disable`,
      {
        method: "POST",
        headers: fixture.headers("platformAdmin"),
      },
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ status: "disabled" });
    expect((await runtime.db.execute(sql`select * from groups`)).rows).toEqual(
      [],
    );
  } finally {
    await fixture.close();
  }
});

test("access queries use issued tenant contexts on a restricted connection", async () => {
  const { organizations, users, members, oauthResources, entitlements } =
    await import("./schema/index.ts");
  const { memberAccess, targetAccess } = await import("./queries/access.ts");
  const memberQueries = await import("./queries/members.ts");
  const { inTenant, inTenantRead } =
    await import("../__tests__/tenant-command.ts");
  const { createId } = await import("../lib/id.ts");
  const userId = createId();
  const resource = `https://${createId()}.example`;
  const tenants = [0, 1].map(() => ({ id: createId(), memberId: createId() }));
  await owner.db.insert(users).values({
    id: userId,
    name: "Shared person",
    email: `${userId}@example.com`,
    status: "active",
  });
  await owner.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resource, name: "Shared target" });
  for (const tenant of tenants) {
    await owner.db.insert(organizations).values({
      id: tenant.id,
      slug: `query-${tenant.id}`,
      name: "Query tenant",
    });
    await owner.db
      .insert(members)
      .values({ id: tenant.memberId, userId, organizationId: tenant.id });
    await owner.db.insert(entitlements).values({
      id: createId(),
      organizationId: tenant.id,
      resource,
      scopes: ["read"],
    });
  }
  expect(
    (await runtime.db.execute(sql`select current_user as name`)).rows,
  ).toEqual([{ name: roleName }]);
  for (const tenant of tenants) {
    await inTenantRead(
      runtime.db,
      tenant.id,
      "memberAccess",
      async (context) => {
        expect(
          (await memberAccess(context, tenant.memberId)).targets,
        ).toMatchObject([{ id: resource, scopes: ["read"] }]);
        const foreign = tenants.find((row) => row.id !== tenant.id)!;
        expect(await memberAccess(context, foreign.memberId)).toEqual({
          effective: false,
          targets: [],
        });
        await expect(
          memberAccess({ ...context }, tenant.memberId),
        ).rejects.toThrow("Invalid or expired");
      },
    );
    await inTenantRead(runtime.db, tenant.id, "directory", async (context) => {
      const page = await targetAccess(context, { resource }, { limit: 10 });
      expect(page.items.map((row) => row.memberId)).toEqual([tenant.memberId]);
      expect(
        (await memberQueries.listMembers(context, { limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([tenant.memberId]);
      const foreign = tenants.find((row) => row.id !== tenant.id)!;
      expect(
        await memberQueries.findMember(context, foreign.memberId),
      ).toBeNull();
    });
    await inTenant(runtime.db, tenant.id, async (context) => {
      const foreign = tenants.find((row) => row.id !== tenant.id)!;
      expect(
        await memberQueries.updateMemberWindow(context, foreign.memberId, {
          validUntil: null,
        }),
      ).toBeNull();
      expect(
        await memberQueries.revokeMember(context, foreign.memberId),
      ).toBeNull();
      expect(
        await memberQueries.reinstateMember(context, foreign.memberId),
      ).toBeNull();
      expect(
        await memberQueries.removeMemberAssignments(context, foreign.memberId),
      ).toEqual({ removedGrants: [], softDeletedGroups: [] });
      expect(
        await memberQueries.revokeMember(context, tenant.memberId),
      ).toMatchObject({ status: "revoked" });
      expect(
        await memberQueries.reinstateMember(context, tenant.memberId),
      ).toMatchObject({ status: "active" });
      expect(
        await memberQueries.findMemberConfiguration(context, tenant.memberId),
      ).toMatchObject({
        organizationId: tenant.id,
        membershipStatus: "active",
      });
    });
  }
  await bootstrap(owner.db, systemActor("admin-explanation-proof"), {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Platform",
    adminResourceIdentifier: environment.adminResourceIdentifier,
  });
  const { effectiveGrants } = await import("./queries/grants.ts");
  const { organizationCapabilities } = await import("./schema/index.ts");
  const adminResource = environment.adminResourceIdentifier;
  for (const tenant of tenants)
    await owner.db.insert(entitlements).values({
      id: createId(),
      organizationId: tenant.id,
      resource: adminResource,
      scopes: ["org:read"],
    });
  await approveAdminCapability(owner.db, {
    organizationId: tenants[0]!.id,
    resource: adminResource,
    scopes: ["org:read"],
  });
  for (const permitted of [0, 1]) {
    if (permitted === 1) {
      await owner.db
        .update(organizationCapabilities)
        .set({ status: "disabled" })
        .where(eq(organizationCapabilities.organizationId, tenants[0]!.id));
      await approveAdminCapability(owner.db, {
        organizationId: tenants[1]!.id,
        resource: adminResource,
        scopes: ["org:read"],
      });
    }
    const grants = await effectiveGrants(runtime.db, { userId }, adminResource);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      organizationId: tenants[permitted]!.id,
      scopes: ["org:read"],
    });
    for (const [index, tenant] of tenants.entries()) {
      const view = await inTenantRead(
        runtime.db,
        tenant.id,
        "memberAccess",
        (context) => memberAccess(context, tenant.memberId),
      );
      expect(
        view.targets.find((target) => target.id === adminResource)!.permission,
      ).toMatchObject({ allowed: index === permitted });
      const page = await inTenantRead(
        runtime.db,
        tenant.id,
        "directory",
        (context) =>
          targetAccess(context, { resource: adminResource }, { limit: 10 }),
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.permission).toMatchObject({
        allowed: index === permitted,
      });
    }
  }
  expect(await runtime.db.select().from(entitlements)).toEqual([]);
});

test("group and entitlement queries preserve tenant scope under the runtime login", async () => {
  const groupQueries = await import("./queries/groups.ts");
  const entitlementQueries = await import("./queries/entitlements.ts");
  const { inPlatformWrite, inPlatformRead } =
    await import("../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { organizations, users, members, oauthResources } =
    await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const resource = `https://${createId()}.example`;
  const userId = createId();
  await owner.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resource, name: "Shared" });
  await owner.db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: "Shared",
    status: "active",
  });
  const tenants: {
    organizationId: string;
    memberId: string;
    group: { id: string };
    entitlement: { id: string };
  }[] = [];
  for (let i = 0; i < 2; i++) {
    const organizationId = createId();
    const memberId = createId();
    await owner.db.insert(organizations).values({
      id: organizationId,
      slug: `policy-${organizationId}`,
      name: "Policy",
    });
    await owner.db
      .insert(members)
      .values({ id: memberId, organizationId, userId });
    const records = await inPlatformWrite(runtime.db, async (context) => {
      const group = await groupQueries.createGroup(context, {
        organizationId,
        slug: "team",
        name: "Team",
      });
      await groupQueries.upsertGroupMember(context, {
        organizationId,
        groupId: group.id,
        memberId,
      });
      const entitlement = await entitlementQueries.createEntitlement(context, {
        organizationId,
        groupId: group.id,
        resource,
        scopes: ["read"],
      });
      return { group, entitlement };
    });
    tenants.push({ organizationId, memberId, ...records });
  }
  for (const tenant of tenants) {
    const foreign = tenants.find((row) => row !== tenant)!;
    await inTenantRead(
      runtime.db,
      tenant.organizationId,
      "directory",
      async (context) => {
        expect(
          (await groupQueries.listGroups(context, { limit: 10 })).map(
            (row) => row.id,
          ),
        ).toEqual([tenant.group.id]);
        expect(
          await groupQueries.findGroup(context, foreign.group.id),
        ).toBeNull();
        expect(
          (
            await groupQueries.listGroupMembers(context, tenant.group.id, {
              limit: 10,
            })
          ).map((row) => row.memberId),
        ).toEqual([tenant.memberId]);
        expect(
          await groupQueries.findGroupMember(
            context,
            foreign.group.id,
            foreign.memberId,
          ),
        ).toBeNull();
        expect(
          (
            await entitlementQueries.listEntitlements(context, { limit: 10 })
          ).map((row) => row.id),
        ).toEqual([tenant.entitlement.id]);
        expect(
          await entitlementQueries.findEntitlement(
            context,
            foreign.entitlement.id,
          ),
        ).toBeNull();
        await expect(
          Reflect.apply(groupQueries.deleteGroup, undefined, [
            context,
            foreign.organizationId,
            foreign.group.id,
          ]),
        ).rejects.toThrow("Invalid or expired");
        await expect(
          Reflect.apply(entitlementQueries.deleteEntitlement, undefined, [
            context,
            foreign.organizationId,
            foreign.entitlement.id,
          ]),
        ).rejects.toThrow("Invalid or expired");
      },
    );
  }
  await inPlatformRead(runtime.db, async (context) => {
    expect(
      (
        await entitlementQueries.listAllEntitlements(context, {
          resource,
          limit: 10,
        })
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual(tenants.map((row) => row.entitlement.id).sort());
  });
  expect((await runtime.db.execute(sql`select * from groups`)).rows).toEqual(
    [],
  );
  expect(
    (await runtime.db.execute(sql`select * from entitlements`)).rows,
  ).toEqual([]);
});

test("restricted audit readers retain tenant isolation and person history after erasure", async () => {
  const auditQueries = await import("./queries/audit.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { inPlatformRead } = await import("../__tests__/platform-context.ts");
  const { users, organizations } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const userId = createId();
  const tenantIds = [createId(), createId()];
  await owner.db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: "Historical person",
    status: "active",
  });
  for (const id of tenantIds)
    await owner.db
      .insert(organizations)
      .values({ id, slug: `history-${id}`, name: "History" });
  const events: Awaited<ReturnType<typeof auditQueries.recordAuditEvent>>[] =
    [];
  for (const organizationId of [...tenantIds, null])
    events.push(
      await auditQueries.recordAuditEvent(runtime.db, {
        organizationId,
        actorType: "system",
        actorId: "history-proof",
        action: "history.retained",
        targetType: "user",
        targetId: userId,
        outcome: "success",
      }),
    );
  await owner.db.delete(users).where(eq(users.id, userId));
  for (const id of tenantIds)
    await owner.db.delete(organizations).where(eq(organizations.id, id));
  for (const organizationId of tenantIds)
    await inTenantRead(
      runtime.db,
      organizationId,
      "history",
      async (context) => {
        const result = await auditQueries.listOrganizationAuditEvents(
          context,
          {
            organizationId: tenantIds.find((id) => id !== organizationId),
          } as never,
          { limit: 10 },
        );
        expect(result.items.map((row) => row.id)).toEqual(
          events
            .filter((event) => event.organizationId === organizationId)
            .map((event) => event.id),
        );
        await expect(
          auditQueries.listUserAuditEvents(
            context as never,
            userId,
            {},
            { limit: 10 },
          ),
        ).rejects.toThrow("Invalid or expired");
      },
    );
  await inPlatformRead(runtime.db, async (context) => {
    const result = await auditQueries.listUserAuditEvents(
      context,
      userId,
      {},
      { limit: 10 },
    );
    expect(result.items.map((row) => row.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );
    expect(() =>
      auditQueries.listAuditEvents({ ...context }, {}, { limit: 10 }),
    ).toThrow("Invalid or expired");
  });
});

test("runtime startup rejects disabled tenant RLS", async () => {
  await owner.db.execute(sql`alter table groups disable row level security`);
  try {
    await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
      "Unsafe database runtime role",
    );
  } finally {
    await owner.db.execute(sql`alter table groups enable row level security`);
  }
  await assertRuntimeRole(runtime.db);
});

test("capability RLS permits tenant inspection but denies tenant ceiling writes", async () => {
  const {
    organizationCapabilities,
    organizations,
    oauthClients,
    oauthResources,
  } = await import("./schema/index.ts");
  const { setDatabaseScope } = await import("./isolation.ts");
  const { createId } = await import("../lib/id.ts");
  const organizationId = createId();
  const otherId = createId();
  const clientId = `rls-cap-${createId()}`;
  const resource = `https://${createId()}.example`;
  await owner.db.insert(organizations).values([
    { id: organizationId, slug: `cap-${organizationId}`, name: "Cap" },
    { id: otherId, slug: `cap-${otherId}`, name: "Other" },
  ]);
  await owner.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    organizationId,
    name: "Cap",
    redirectUris: [],
  });
  await owner.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resource, name: "Cap" });
  const cap = await approveMachineCapability(owner.db, {
    organizationId,
    clientId,
    resource,
    scopes: ["read"],
  });
  expect(await runtime.db.select().from(organizationCapabilities)).toEqual([]);
  for (const access of ["read", "write"] as const) {
    await runtime.db.transaction(async (tx) => {
      await setDatabaseScope(tx, { kind: "tenant", access, organizationId });
      expect(
        (await tx.select().from(organizationCapabilities)).map((row) => row.id),
      ).toEqual([cap.id]);
      expect(
        await tx
          .update(organizationCapabilities)
          .set({ status: "disabled" })
          .returning(),
      ).toEqual([]);
      await expect(
        tx.transaction((nested) =>
          nested.delete(organizationCapabilities).returning(),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });
    await expect(
      runtime.db.transaction(async (tx) => {
        await setDatabaseScope(tx, { kind: "tenant", access, organizationId });
        await tx.insert(organizationCapabilities).values({
          id: createId(),
          organizationId,
          clientId,
          resource,
          grantKind: "authorization_code",
          scopes: ["read"],
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  }
  await runtime.db.transaction(async (tx) => {
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "read",
      organizationId: otherId,
    });
    expect(await tx.select().from(organizationCapabilities)).toEqual([]);
  });
  expect(await runtime.db.select().from(organizationCapabilities)).toEqual([]);
  await runtime.db.transaction(async (tx) => {
    await setDatabaseScope(tx, { kind: "platform", access: "write" });
    expect(
      (
        await tx
          .update(organizationCapabilities)
          .set({ status: "disabled" })
          .where(eq(organizationCapabilities.id, cap.id))
          .returning()
      )[0]!.revision,
    ).toBe(2);
  });
  await owner.db.execute(
    sql`alter table organization_capabilities disable row level security`,
  );
  try {
    await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
      "Unsafe database runtime role",
    );
  } finally {
    await owner.db.execute(
      sql`alter table organization_capabilities enable row level security`,
    );
  }
});

test("runtime erasure audit creates protected indirect subject references through its trigger", async () => {
  const { recordAuditEvent, listUserAuditEvents } =
    await import("../__tests__/audit-queries.ts");
  const affected = crypto.randomUUID();
  const row = await recordAuditEvent(runtime.db, {
    actorType: "system",
    actorId: "root",
    action: "user.erased",
    targetType: "user",
    targetId: crypto.randomUUID(),
    outcome: "success",
    data: { deletedGrantContexts: [{ userId: affected }] },
  });
  expect(
    (await listUserAuditEvents(runtime.db, affected, {}, { limit: 10 })).items,
  ).toEqual([row]);
  await assertRuntimeRole(runtime.db);
});

test("runtime lifecycle audit indexes recorded users without direct subject write privileges", async () => {
  const { recordAuditEvent, listUserAuditEvents } =
    await import("../__tests__/audit-queries.ts");
  const affected = crypto.randomUUID();
  const expected = [];
  for (const targetType of ["client", "resource", "organization"]) {
    for (const erased of [false, true]) {
      const targetId = crypto.randomUUID();
      const effects = [{ userId: affected }, { userId: affected }];
      expected.push(
        await recordAuditEvent(runtime.db, {
          actorType: "system",
          actorId: "root",
          targetType,
          targetId,
          organizationId: targetType === "organization" ? targetId : null,
          action:
            targetType === "client"
              ? erased
                ? "client.grants_erased"
                : "client.grants_revoked"
              : `${targetType}.${erased ? "erased" : "disabled"}`,
          outcome: "success",
          data:
            targetType === "client"
              ? { grantContexts: effects }
              : erased
                ? { deletedGrantContexts: effects }
                : { effects: { revokedGrantContexts: effects } },
        }),
      );
    }
  }
  expect(
    (await listUserAuditEvents(runtime.db, affected, {}, { limit: 10 })).items,
  ).toEqual(expected.reverse());
  await assertRuntimeRole(runtime.db);
});

test("restricted runtime evaluates exact user pairs through scoped policy reads", async () => {
  const { createSsoProvider } = await import("../__tests__/sso-queries.ts");
  const { setDatabaseScope, withDatabaseScope } =
    await import("./isolation.ts");
  const { userResourcePolicy } =
    await import("../auth/user-resource-policy.ts");
  const {
    accounts,
    users,
    members,
    sessions,
    organizations,
    oauthClients,
    oauthResources,
    oauthClientResources,
    grantContexts,
    organizationCapabilities,
    entitlements,
  } = await import("./schema/index.ts");
  const userId = crypto.randomUUID(),
    organizationId = crypto.randomUUID(),
    memberId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    clientInstanceId = crypto.randomUUID(),
    resourceInstanceId = crypto.randomUUID(),
    pairId = crypto.randomUUID();
  const clientId = `policy-${clientInstanceId}`,
    resource = `https://${resourceInstanceId}.example`,
    authTime = new Date();
  await owner.db
    .insert(organizations)
    .values({ id: organizationId, slug: organizationId, name: "Policy" });
  await owner.db.insert(users).values({
    id: userId,
    name: "Policy",
    email: `${userId}@example.com`,
    status: "active",
  });
  await owner.db
    .insert(members)
    .values({ id: memberId, organizationId, userId });
  // Stored policy fixture; native acceptance is covered by the admission suite.
  const provider = await createSsoProvider(owner.db, {
    organizationId,
    providerId: organizationId,
    issuer: "https://policy.example.com",
    domain: "example.com",
    oidc: { clientId: "policy", clientSecret: "secret" },
  });
  const accountId = crypto.randomUUID();
  await owner.db.insert(accounts).values({
    id: accountId,
    userId,
    issuer: provider.issuer,
    providerId: provider.providerId,
    accountId: userId,
  });
  await owner.db.insert(sessions).values({
    id: sessionId,
    userId,
    token: crypto.randomUUID(),
    createdAt: authTime,
    authenticationOrganizationId: organizationId,
    authenticationProviderId: provider.id,
    authenticationProviderRevision: provider.revision,
    authenticationAccountId: accountId,
    expiresAt: new Date(Date.now() + 60000),
  });
  await owner.db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId,
    redirectUris: [],
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: ["openid", "read"],
  });
  await owner.db.insert(oauthResources).values({
    id: resourceInstanceId,
    identifier: resource,
    name: "Policy",
    allowedScopes: ["read"],
  });
  await owner.db
    .insert(oauthClientResources)
    .values({ id: crypto.randomUUID(), clientId, resourceId: resource });
  const { createResourceGrant } =
    await import("../auth/create-resource-grant.ts");
  const { id: grantId } = await createResourceGrant(
    runtime.db,
    {
      memberId,
      userId,
      sessionId,
      clientId,
      resource,
      scopes: ["openid", "read"],
    },
    60,
  );

  await owner.db
    .delete(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId));
  await expect(
    createResourceGrant(
      runtime.db,
      {
        memberId,
        userId,
        sessionId,
        clientId,
        resource,
        scopes: ["openid", "read"],
      },
      60,
    ),
  ).rejects.toMatchObject({ body: { error: "access_denied" } });
  expect(
    await owner.db
      .select({ id: grantContexts.id })
      .from(grantContexts)
      .where(eq(grantContexts.userId, userId)),
  ).toEqual([{ id: grantId }]);
  await owner.db
    .insert(oauthClientResources)
    .values({ id: crypto.randomUUID(), clientId, resourceId: resource });

  await owner.db.insert(organizationCapabilities).values([
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource: null,
      grantKind: "authorization_code",
      scopes: ["openid"],
    },
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource,
      grantKind: "authorization_code",
      scopes: ["read"],
    },
  ]);
  await owner.db.insert(entitlements).values([
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource: null,
      scopes: ["openid"],
    },
    { id: pairId, organizationId, clientId, resource, scopes: ["read"] },
  ]);
  const input = {
    id: grantId,
    clientId,
    resource,
    grantType: "authorization_code" as const,
    requestedScopes: ["openid", "read"],
  };
  const { lockResourceGrantPolicy } =
    await import("../auth/lock-resource-grant-policy.ts");
  const { authTransaction } = await import("../auth/database-adapter.ts");
  const adapter = (await createAuth(runtime.db, environment).$context).adapter;
  const decision = await adapter.transaction(async (bound) => {
    await setDatabaseScope(authTransaction(bound), {
      kind: "grant-client",
      clientId,
    });
    await lockResourceGrantPolicy(bound, input);
    return userResourcePolicy(authTransaction(bound), input);
  });
  expect(decision).toMatchObject({
    allowed: true,
    scopes: ["read"],
    reason: "approved",
    grantType: "authorization_code",
    subjectType: "user",
    organization: { id: organizationId, authorizationVersion: 1 },
    subject: { userId, memberId },
    client: { id: clientInstanceId, clientId },
    resource: { id: resourceInstanceId, identifier: resource },
    requestedScopes: ["openid", "read"],
  });
  const { memberAccess, targetAccess } = await import("./queries/access.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const otherId = crypto.randomUUID(),
    otherMemberId = crypto.randomUUID();
  await owner.db
    .insert(organizations)
    .values({ id: otherId, slug: otherId, name: "Other policy" });
  await owner.db
    .insert(members)
    .values({ id: otherMemberId, organizationId: otherId, userId });
  await owner.db.insert(entitlements).values({
    id: crypto.randomUUID(),
    organizationId: otherId,
    clientId,
    resource,
    scopes: ["read"],
  });
  async function checkExplanation(allowed: boolean) {
    const view = await inTenantRead(
      runtime.db,
      organizationId,
      "memberAccess",
      (context) => memberAccess(context, memberId),
    );
    expect(
      view.targets.find((target) => target.kind === "client_resource")
        ?.permission,
    ).toMatchObject({ allowed });
    expect(
      view.targets.find((target) => target.kind === "client")!.permission,
    ).toMatchObject({ allowed });
    const loginPage = await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      (context) => targetAccess(context, { clientId }, { limit: 10 }),
    );
    expect(loginPage.items[0]!.permission).toMatchObject({ allowed });
    const page = await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      (context) => targetAccess(context, { clientId, resource }, { limit: 10 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.permission).toMatchObject({ allowed });
    if (!allowed)
      expect(page.items[0]!.permission).toEqual({
        allowed: false,
        reason: "context",
      });
    const foreign = await inTenantRead(
      runtime.db,
      otherId,
      "memberAccess",
      (context) => memberAccess(context, otherMemberId),
    );
    expect(foreign.targets[0]?.permission).toEqual({
      allowed: false,
      reason: allowed ? "login" : "context",
    });
  }
  await checkExplanation(true);

  await owner.db
    .update(oauthClients)
    .set({ grantTypes: ["refresh_token"] })
    .where(eq(oauthClients.id, clientInstanceId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "context",
    scopes: [],
    grantType: "authorization_code",
    organization: { id: organizationId },
    subject: { userId, memberId },
    client: { id: clientInstanceId, clientId },
    resource: { id: resourceInstanceId, identifier: resource },
  });
  await checkExplanation(false);
  await owner.db
    .update(oauthClients)
    .set({ grantTypes: ["authorization_code", "refresh_token"] })
    .where(eq(oauthClients.id, clientInstanceId));
  await owner.db
    .update(oauthClients)
    .set({ scopes: null })
    .where(eq(oauthClients.id, clientInstanceId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "login",
  });
  await owner.db
    .update(oauthClients)
    .set({ scopes: ["openid", "read"] })
    .where(eq(oauthClients.id, clientInstanceId));
  await owner.db.delete(entitlements).where(eq(entitlements.id, pairId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "scope",
  });
  await assertRuntimeRole(runtime.db);
});

test("restricted domain readers never load another tenant's routing identity", async () => {
  const queries = await import("./queries/organization-domains.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { inPlatformWrite } = await import("../__tests__/platform-context.ts");
  const { organizations } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const tenants = [];
  for (let i = 0; i < 2; i++) {
    const id = createId();
    await owner.db
      .insert(organizations)
      .values({ id, slug: `domain-${id}`, name: "Domain" });
    const domain = await inPlatformWrite(runtime.db, (context) =>
      queries.createOrganizationDomain(context, {
        organizationId: id,
        domain: `${id}.example`,
      }),
    );
    tenants.push({ id, domain });
  }
  for (const tenant of tenants) {
    const foreign = tenants.find((row) => row !== tenant)!;
    await inTenantRead(runtime.db, tenant.id, "directory", async (context) => {
      expect(
        await queries.listOrganizationDomains(context, { limit: 10 }),
      ).toEqual([tenant.domain]);
    });
    await inTenantRead(
      runtime.db,
      tenant.id,
      "memberAccess",
      async (context) => {
        expect(
          await queries.organizationAcceptsDomain(
            context,
            tenant.domain.domain.toUpperCase(),
          ),
        ).toBe(true);
        expect(
          await queries.organizationAcceptsDomain(
            context,
            foreign.domain.domain,
          ),
        ).toBe(false);
        expect(
          await queries.organizationAcceptsDomain(context, "unknown.example"),
        ).toBe(false);
      },
    );
  }
  const first = tenants[0]!;
  const second = tenants[1]!;
  await inPlatformWrite(runtime.db, async (context) => {
    expect(
      await queries.setOrganizationDomainStatus(
        context,
        first.id,
        second.domain.id,
        "disabled",
      ),
    ).toBeNull();
    await queries.deleteOrganizationDomain(context, first.id, second.domain.id);
    await queries.setOrganizationDomainStatus(
      context,
      first.id,
      first.domain.id,
      "disabled",
    );
  });
  await inTenantRead(runtime.db, first.id, "memberAccess", async (context) => {
    expect(
      await queries.organizationAcceptsDomain(context, first.domain.domain),
    ).toBe(false);
  });
  await inTenantRead(runtime.db, second.id, "memberAccess", async (context) => {
    expect(
      await queries.organizationAcceptsDomain(context, second.domain.domain),
    ).toBe(true);
  });
});

test("restricted SSO queries keep tenant projections separate from command secrets", async () => {
  const queries = await import("./queries/sso-providers.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { inPlatformWrite, inPlatformRead } =
    await import("../__tests__/platform-context.ts");
  const { organizations } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const tenants = [];
  for (let i = 0; i < 2; i++) {
    const id = createId();
    await owner.db
      .insert(organizations)
      .values({ id, slug: `sso-query-${id}`, name: "SSO query" });
    const provider = await inPlatformWrite(runtime.db, (context) =>
      queries.createSsoProvider(context, {
        organizationId: id,
        providerId: id,
        issuer: `https://${id}.example`,
        domain: `${id}.example`,
        oidc: { clientId: id, clientSecret: `secret-${id}` },
      }),
    );
    tenants.push({ id, provider });
  }
  for (const tenant of tenants) {
    const other = tenants.find((row) => row !== tenant)!;
    await inTenantRead(runtime.db, tenant.id, "directory", async (context) => {
      const provider = await queries.readSsoProvider(context);
      expect(provider?.id).toBe(tenant.provider.id);
      expect(provider?.oidc.hasClientSecret).toBe(true);
      expect(JSON.stringify(provider)).not.toContain(`secret-${tenant.id}`);
      expect(JSON.stringify(provider)).not.toContain(other.id);
    });
    await inTenantRead(runtime.db, tenant.id, "memberAccess", async (context) =>
      expect(await queries.readSsoIssuer(context)).toEqual({
        issuer: tenant.provider.issuer,
      }),
    );
    await inPlatformRead(runtime.db, async (context) =>
      expect(await queries.readSsoEndpoints(context, tenant.id)).toEqual({
        issuer: tenant.provider.issuer,
        discoveryEndpoint: `${tenant.provider.issuer}/.well-known/openid-configuration`,
      }),
    );
    await inPlatformWrite(runtime.db, async (context) =>
      expect(
        (await queries.findSsoProviderForCommand(context, tenant.id))
          ?.oidcConfig,
      ).toContain(`secret-${tenant.id}`),
    );
  }
});

test("restricted organisation readers keep tenant detail, diagnosis and retained-history existence distinct", async () => {
  const queries = await import("./queries/organizations.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { inPlatformRead, inPlatformWrite } =
    await import("../__tests__/platform-context.ts");
  const { createId } = await import("../lib/id.ts");
  const prefix = createId();
  const tenants: Awaited<ReturnType<typeof queries.createOrganization>>[] = [];
  for (let i = 0; i < 2; i++)
    tenants.push(
      await inPlatformWrite(runtime.db, (context) =>
        queries.createOrganization(context, {
          slug: `org-query-${prefix}-${i}`,
          name: `Org ${i}`,
          metadata: `private-${i}`,
        }),
      ),
    );
  for (const tenant of tenants) {
    await inTenantRead(runtime.db, tenant.id, "directory", async (context) =>
      expect(await queries.readOrganization(context)).toEqual(tenant),
    );
    await inTenantRead(runtime.db, tenant.id, "memberAccess", async (context) =>
      expect(await queries.readOrganizationStatus(context)).toEqual({
        id: tenant.id,
        slug: tenant.slug,
        status: tenant.status,
      }),
    );
    await inTenantRead(runtime.db, tenant.id, "history", async (context) =>
      expect(await queries.organizationExistsForHistory(context)).toBe(true),
    );
  }
  await inPlatformRead(runtime.db, async (context) =>
    expect(
      (await queries.listOrganizations(context, { limit: 10, q: prefix }))
        .map((row) => row.id)
        .sort(),
    ).toEqual(tenants.map((row) => row.id).sort()),
  );
  const first = tenants[0]!;
  await inPlatformWrite(runtime.db, async (context) => {
    expect(await queries.lockOrganizationForCommand(context, first.id)).toEqual(
      first,
    );
    await queries.deleteOrganization(context, first.id);
  });
  await inTenantRead(runtime.db, first.id, "history", async (context) =>
    expect(await queries.organizationExistsForHistory(context)).toBe(false),
  );
  await expect(
    inTenantRead(runtime.db, first.id, "directory", queries.readOrganization),
  ).rejects.toMatchObject({ status: 404 });
  await inTenantRead(runtime.db, tenants[1]!.id, "directory", async (context) =>
    expect(await queries.readOrganization(context)).toEqual(tenants[1]!),
  );
});

test("restricted global user/session queries preserve global scope and exclude credentials", async () => {
  const userQueries = await import("./queries/users.ts");
  const sessionQueries = await import("./queries/sessions.ts");
  const { inPlatformRead, inPlatformUsers } =
    await import("../__tests__/platform-context.ts");
  const { users, members, organizations, sessions, accounts } =
    await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const userId = createId();
  const otherId = createId();
  for (const id of [userId, otherId])
    await owner.db
      .insert(users)
      .values({ id, email: `${id}@example.com`, name: id, status: "active" });
  const tenantIds = [createId(), createId()];
  for (const organizationId of tenantIds) {
    await owner.db.insert(organizations).values({
      id: organizationId,
      slug: `global-${organizationId}`,
      name: "Global member",
    });
    await owner.db
      .insert(members)
      .values({ id: createId(), organizationId, userId });
  }
  const sessionIds: string[] = [];
  for (const id of [userId, otherId]) {
    const sessionId = createId();
    sessionIds.push(sessionId);
    await owner.db.insert(sessions).values({
      id: sessionId,
      userId: id,
      token: `secret-${sessionId}`,
      activeOrganizationId: tenantIds[0]!,
      expiresAt: new Date(Date.now() + 60000),
    });
  }
  await owner.db.insert(accounts).values({
    id: createId(),
    userId,
    providerId: "test",
    accountId: userId,
    issuer: "https://global.example",
    accessToken: "upstream-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
  });
  await inPlatformRead(runtime.db, async (context) => {
    expect(
      (
        await userQueries.listUsers(context, {
          limit: 10,
          organizationId: tenantIds[1],
        })
      ).map((row) => row.id),
    ).toEqual([userId]);
    const user = await userQueries.findUser(context, userId);
    expect(user?.memberships.map((row) => row.organizationId).sort()).toEqual(
      tenantIds.sort(),
    );
    expect(user?.sessionCount).toBe(1);
    expect(JSON.stringify(user)).not.toContain("-secret");
    const rows = await sessionQueries.listUserSessions(context, userId, {
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual([sessionIds[0]!]);
    expect(rows[0]).not.toHaveProperty("token");
  });
  await inPlatformUsers(runtime.db, async (context) => {
    await userQueries.lockUser(context, userId);
    expect(
      await sessionQueries.findUserSession(context, userId, sessionIds[1]!),
    ).toBeNull();
    expect(
      await sessionQueries.deleteSession(context, userId, sessionIds[1]!),
    ).toBeNull();
    expect(await sessionQueries.deleteUserSessionIds(context, userId)).toEqual([
      sessionIds[0]!,
    ]);
    expect(await sessionQueries.deleteUserSessionIds(context, userId)).toEqual(
      [],
    );
  });
  await inPlatformRead(runtime.db, async (context) => {
    expect(
      await sessionQueries.listUserSessions(context, userId, { limit: 10 }),
    ).toEqual([]);
    expect(
      (
        await sessionQueries.listUserSessions(context, otherId, { limit: 10 })
      ).map((row) => row.id),
    ).toEqual([sessionIds[1]!]);
    expect(
      (await userQueries.findUser(context, userId))?.memberships,
    ).toHaveLength(2);
  });
});

test("restricted resource queries hide foreign private targets while preserving platform inventory", async () => {
  const queries = await import("./queries/oauth-resources.ts");
  const { inPlatformRead, inPlatformWrite } =
    await import("../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { organizations } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const tenantIds = [createId(), createId()];
  for (const id of tenantIds)
    await owner.db
      .insert(organizations)
      .values({ id, slug: `resource-${id}`, name: "Resource" });
  const prefix = createId();
  const resources: Awaited<ReturnType<typeof queries.createResource>>[] = [];
  await inPlatformWrite(runtime.db, async (context) => {
    resources.push(
      await queries.createResource(context, {
        identifier: `https://${prefix}-shared.example`,
        name: "Shared",
        allowedScopes: ["read"],
      }),
    );
    for (const organizationId of tenantIds)
      resources.push(
        await queries.createResource(context, {
          identifier: `https://${prefix}-${organizationId}.example`,
          name: "Private",
          classification: "tenant_owned",
          organizationId,
          allowedScopes: ["read"],
        }),
      );
  });
  for (const organizationId of tenantIds)
    await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      async (context) => {
        for (const resource of resources) {
          const result = await queries.findResourceForAccess(
            context,
            resource.identifier,
          );
          if (
            resource.classification === "platform_shared" ||
            resource.organizationId === organizationId
          )
            expect(result).toEqual({ id: resource.id });
          else expect(result).toBeNull();
        }
        expect(
          await queries.findResourceForAccess(
            context,
            "https://missing.example",
          ),
        ).toBeNull();
      },
    );
  await inPlatformRead(runtime.db, async (context) => {
    expect(
      (await queries.listResources(context, { limit: 10, q: prefix }))
        .map((row) => row.id)
        .sort(),
    ).toEqual(resources.map((row) => row.id).sort());
    for (const resource of resources)
      expect(await queries.readResource(context, resource.identifier)).toEqual(
        resource,
      );
  });
  await inPlatformWrite(runtime.db, async (context) => {
    for (const resource of resources)
      expect(
        await queries.readResourceForPolicy(context, resource.identifier),
      ).toEqual(resource);
  });
});

test("restricted client queries exclude digests and preserve shared registration semantics", async () => {
  const queries = await import("./queries/oauth-clients.ts");
  const { inPlatformRead, inPlatformWrite } =
    await import("../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const { organizations } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const tenantIds = [createId(), createId()];
  for (const id of tenantIds)
    await owner.db
      .insert(organizations)
      .values({ id, slug: `client-query-${id}`, name: "Client query" });
  const prefix = createId();
  const clients: Awaited<ReturnType<typeof queries.createClient>>[] = [];
  await inPlatformWrite(runtime.db, async (context) => {
    for (const [i, organizationId] of [...tenantIds, null].entries())
      clients.push(
        await queries.createClient(context, {
          clientId: `${prefix}-${i}`,
          organizationId,
          redirectUris: [],
          clientSecret: organizationId === null ? null : `private-digest-${i}`,
        }),
      );
  });
  await inPlatformRead(runtime.db, async (context) => {
    const rows = await queries.listClients(context, { limit: 10, q: prefix });
    expect(rows.map((row) => row.id).sort()).toEqual(
      clients.map((row) => row.id).sort(),
    );
    for (const client of clients) {
      const { clientSecret, ...expected } = client;
      const result = await queries.readClient(context, client.clientId);
      expect(result).toEqual({
        ...expected,
        hasClientSecret: clientSecret !== null,
      });
      expect(rows.find((row) => row.id === client.id)).toEqual(result!);
      expect(result).not.toHaveProperty("clientSecret");
    }
    expect(JSON.stringify(rows)).not.toContain("private-digest");
  });
  await inPlatformWrite(runtime.db, async (context) => {
    for (const client of clients) {
      const policy = await queries.readClientForPolicy(
        context,
        client.clientId,
      );
      expect(policy).not.toHaveProperty("clientSecret");
      expect(policy?.hasClientSecret).toBe(client.clientSecret !== null);
      expect(
        (await queries.lockClientForCommand(context, client.clientId))
          ?.clientSecret,
      ).toBe(client.clientSecret);
    }
  });
  for (const organizationId of tenantIds)
    await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      async (context) => {
        for (const client of clients)
          expect(
            await queries.findClientForAccess(context, client.clientId),
          ).toEqual({ id: client.id });
        expect(
          await queries.findClientForAccess(context, "missing-client-query"),
        ).toBeNull();
      },
    );
});

test("restricted revocation queries preserve their tenant, user, client and session boundaries", async () => {
  const queries = await import("./queries/oauth-tokens.ts");
  const { revokeMemberGrantContexts } =
    await import("./queries/grant-contexts.ts");
  const { inPlatformUsers, inPlatformWrite } =
    await import("../__tests__/platform-context.ts");
  const { inTenant } = await import("../__tests__/tenant-command.ts");
  const {
    organizations,
    users,
    sessions,
    members,
    oauthClients,
    oauthAccessTokens,
    oauthRefreshTokens,
    grantContexts,
  } = await import("./schema/index.ts");
  const { createId } = await import("../lib/id.ts");
  const authTime = new Date();
  const tenantIds = [createId(), createId()];
  const userIds = [createId(), createId()];
  const sessionIds = [createId(), createId()];
  const clientIds = [createId(), createId()];
  for (let i = 0; i < 2; i++) {
    await owner.db.insert(organizations).values({
      id: tenantIds[i]!,
      slug: `revoke-${tenantIds[i]}`,
      name: "Revocation",
    });
    await owner.db.insert(users).values({
      id: userIds[i]!,
      name: "Revocation",
      email: `${userIds[i]}@example.com`,
      status: "active",
    });
    await owner.db.insert(sessions).values({
      id: sessionIds[i]!,
      userId: userIds[i]!,
      token: createId(),
      createdAt: authTime,
      expiresAt: new Date(Date.now() + 60000),
    });
    await owner.db.insert(oauthClients).values({
      id: clientIds[i]!,
      clientId: clientIds[i]!,
      organizationId: tenantIds[i]!,
      redirectUris: [],
      scopes: ["openid"],
    });
  }
  const specs = [
    { clientId: clientIds[0]!, userId: userIds[0]!, sessionId: sessionIds[0]! },
    { clientId: clientIds[1]!, userId: userIds[0]!, sessionId: sessionIds[0]! },
    { clientId: clientIds[0]!, userId: userIds[1]!, sessionId: sessionIds[1]! },
    { clientId: clientIds[1]!, userId: userIds[1]!, sessionId: sessionIds[1]! },
    { clientId: clientIds[0]!, userId: null, sessionId: null },
    { clientId: clientIds[1]!, userId: null, sessionId: null },
  ];
  for (const kind of ["user", "session", "client", "organization"] as const) {
    const seeded: {
      table: typeof oauthAccessTokens | typeof oauthRefreshTokens;
      id: string;
      shouldRevoke: boolean;
    }[] = [];
    for (const spec of specs) {
      const shouldRevoke =
        kind === "user"
          ? spec.userId === userIds[0]
          : kind === "session"
            ? spec.sessionId === sessionIds[0]
            : kind === "client"
              ? spec.clientId === clientIds[0]
              : spec.clientId === clientIds[0] && spec.userId === null;
      for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
        if (table === oauthRefreshTokens && spec.userId === null) continue;
        const id = createId();
        await owner.db.insert(table).values({
          ...spec,
          id,
          token: createId(),
          scopes: [],
          expiresAt: new Date(Date.now() + 60000),
        });
        seeded.push({ table, id, shouldRevoke });
      }
    }
    if (kind === "user")
      await inPlatformUsers(runtime.db, (context) =>
        queries.revokeUserTokens(context, userIds[0]!),
      );
    else if (kind === "session")
      await inPlatformUsers(runtime.db, (context) =>
        queries.revokeSessionTokens(context, sessionIds[0]!),
      );
    else if (kind === "client")
      await inPlatformWrite(runtime.db, (context) =>
        queries.revokeClientTokens(context, clientIds[0]!),
      );
    else
      await inPlatformWrite(runtime.db, (context) =>
        queries.revokeOrganizationMachineTokens(context, tenantIds[0]!),
      );
    for (const { table, id, shouldRevoke } of seeded) {
      const [row] = await owner.db
        .select({ revoked: table.revoked })
        .from(table)
        .where(eq(table.id, id));
      expect(row!.revoked !== null).toBe(shouldRevoke);
    }
  }
  const grants: { id: string; memberId: string }[] = [];
  for (const [tenantIndex, userIndex] of [
    [0, 0],
    [0, 1],
    [1, 0],
  ] as const) {
    const memberId = createId();
    await owner.db.insert(members).values({
      id: memberId,
      organizationId: tenantIds[tenantIndex]!,
      userId: userIds[userIndex]!,
      status: "active",
    });
    const id = createId();
    await owner.db.insert(grantContexts).values({
      id,
      organizationId: tenantIds[tenantIndex]!,
      memberId,
      userId: userIds[userIndex]!,
      clientInstanceId: clientIds[0]!,
      authenticationSessionId: sessionIds[userIndex]!,
      authTime,
      requestedScopes: ["openid"],
      expiresAt: new Date(Date.now() + 60000),
    });
    grants.push({ id, memberId });
  }
  await inTenant(runtime.db, tenantIds[0]!, async (context) => {
    expect(
      await revokeMemberGrantContexts(context, grants[2]!.memberId),
    ).toEqual([]);
    expect(
      await revokeMemberGrantContexts(context, grants[0]!.memberId),
    ).toEqual([{ id: grants[0]!.id }]);
    expect(
      await revokeMemberGrantContexts(context, grants[0]!.memberId),
    ).toEqual([]);
  });
  for (const [i, grant] of grants.entries()) {
    const [row] = await owner.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.id, grant.id));
    expect(row!.revokedAt !== null).toBe(i === 0);
  }
  // Reuse the identities above, but give each command fresh contexts so exact
  // returned effects and surviving rows can be compared independently.
  const grantQueries = await import("./queries/grant-contexts.ts");
  const { oauthResources } = await import("./schema/index.ts");
  for (const grant of grants)
    await owner.db.delete(grantContexts).where(eq(grantContexts.id, grant.id));
  const resourceIds = [createId(), createId()];
  for (const id of resourceIds)
    await owner.db.insert(oauthResources).values({
      id,
      identifier: `https://${id}.example`,
      name: "Revocation",
      allowedScopes: ["openid"],
    });
  const ownedClientId = createId();
  await owner.db.insert(oauthClients).values({
    id: ownedClientId,
    clientId: ownedClientId,
    userId: userIds[0]!,
    redirectUris: [],
    scopes: ["openid"],
  });
  const otherMemberId = createId();
  await owner.db.insert(members).values({
    id: otherMemberId,
    organizationId: tenantIds[1]!,
    userId: userIds[1]!,
    status: "active",
  });
  const targets = [
    {
      organizationId: tenantIds[0]!,
      memberId: grants[0]!.memberId,
      userId: userIds[0]!,
      clientInstanceId: clientIds[0]!,
      resourceInstanceId: resourceIds[0]!,
      authenticationSessionId: sessionIds[0]!,
    },
    {
      organizationId: tenantIds[1]!,
      memberId: grants[2]!.memberId,
      userId: userIds[0]!,
      clientInstanceId: clientIds[0]!,
      resourceInstanceId: resourceIds[1]!,
      authenticationSessionId: sessionIds[0]!,
    },
    {
      organizationId: tenantIds[0]!,
      memberId: grants[1]!.memberId,
      userId: userIds[1]!,
      clientInstanceId: clientIds[1]!,
      resourceInstanceId: resourceIds[1]!,
      authenticationSessionId: sessionIds[1]!,
    },
    {
      organizationId: tenantIds[1]!,
      memberId: otherMemberId,
      userId: userIds[1]!,
      clientInstanceId: ownedClientId,
      resourceInstanceId: resourceIds[0]!,
      authenticationSessionId: sessionIds[1]!,
    },
  ];
  for (const operation of [
    "revokeUser",
    "revokeSession",
    "revokeUserAndOwnedClients",
    "revokeOrganization",
    "revokeResource",
    "revokeClient",
  ] as const) {
    const ids = targets.map(() => createId());
    for (const [index, target] of targets.entries())
      await owner.db.insert(grantContexts).values({
        ...target,
        id: ids[index]!,
        authTime,
        requestedScopes: ["openid"],
        expiresAt: new Date(Date.now() + 60000),
      });
    const expected = ids.filter((_, index) =>
      operation === "revokeUserAndOwnedClients"
        ? index !== 2
        : operation === "revokeUser" || operation === "revokeSession"
          ? index < 2
          : operation.includes("Resource")
            ? index === 0 || index === 3
            : operation.includes("Client")
              ? index < 2
              : index === 0 || index === 2,
    );
    const run = () =>
      operation === "revokeUser"
        ? inPlatformUsers(runtime.db, (context) =>
            grantQueries.revokeUserGrantContexts(context, userIds[0]!),
          )
        : operation === "revokeSession"
          ? inPlatformUsers(runtime.db, (context) =>
              grantQueries.revokeSessionGrantContexts(
                context,
                userIds[0]!,
                sessionIds[0]!,
              ),
            )
          : inPlatformWrite(runtime.db, (context) => {
              switch (operation) {
                case "revokeUserAndOwnedClients":
                  return grantQueries.revokeUserAndOwnedClientGrantContexts(
                    context,
                    userIds[0]!,
                  );
                case "revokeOrganization":
                  return grantQueries.revokeOrganizationGrantContexts(
                    context,
                    tenantIds[0]!,
                  );
                case "revokeResource":
                  return grantQueries.revokeResourceGrantContexts(
                    context,
                    resourceIds[0]!,
                  );
                case "revokeClient":
                  return grantQueries.revokeClientGrantContexts(
                    context,
                    clientIds[0]!,
                  );
              }
            });
    expect((await run()).map((row) => row.id).sort()).toEqual(
      [...expected].sort(),
    );
    expect(await run()).toEqual([]);
    for (const id of ids) {
      const [row] = await owner.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id));
      expect(row).toBeDefined();
      expect(row!.revokedAt !== null).toBe(expected.includes(id));
      await owner.db.delete(grantContexts).where(eq(grantContexts.id, id));
    }
  }
});

test("runtime startup refuses disabled grant-context RLS", async () => {
  await owner.db.execute(
    sql`alter table grant_contexts disable row level security`,
  );
  try {
    await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
      "Unsafe database runtime role",
    );
  } finally {
    await owner.db.execute(
      sql`alter table grant_contexts enable row level security`,
    );
  }
  await assertRuntimeRole(runtime.db);
});

test("administrative RLS isolates rows while retaining routing and append-only broker access", async () => {
  const { createId } = await import("../lib/id.ts");
  const {
    members,
    invitations,
    organizationDomains,
    ssoProviders,
    organizations,
    users,
    auditEventSubjects,
  } = await import("./schema/index.ts");
  const { recordAuditEvent } = await import("./queries/audit.ts");
  const userId = createId();
  await owner.db.insert(users).values({
    id: userId,
    name: "RLS subject",
    email: `${userId}@example.com`,
    status: "active",
  });
  const tenants = [createId(), createId()];
  for (const organizationId of tenants) {
    await owner.db.insert(organizations).values({
      id: organizationId,
      slug: `rls-${organizationId}`,
      name: "RLS tenant",
    });
    await owner.db
      .insert(members)
      .values({ id: createId(), organizationId, userId });
    await owner.db.insert(invitations).values({
      id: createId(),
      organizationId,
      email: "invite@example.com",
      inviterId: userId,
      expiresAt: new Date(Date.now() + 60000),
    });
    await owner.db.insert(organizationDomains).values({
      id: createId(),
      organizationId,
      domain: `${organizationId}.example.com`,
    });
    await owner.db.insert(ssoProviders).values({
      id: createId(),
      organizationId,
      providerId: organizationId,
      issuer: "https://issuer.example.com",
      domain: `${organizationId}.example.com`,
    });
    await recordAuditEvent(runtime.db, {
      organizationId,
      actorType: "system",
      actorId: "rls-proof",
      action: "rls.proof",
      targetType: "user",
      targetId: userId,
      outcome: "success",
    });
  }
  for (const organizationId of tenants) {
    await withDatabaseScope(
      runtime.db,
      { kind: "tenant", access: "read", organizationId },
      async (tx) => {
        // Deliberately omit application tenant predicates.
        for (const table of [
          members,
          invitations,
          auditEvents,
          auditEventSubjects,
        ]) {
          const rows = await tx
            .select({ organizationId: table.organizationId })
            .from(table);
          expect(rows.length).toBeGreaterThan(0);
          expect(
            rows.every((row) => row.organizationId === organizationId),
          ).toBe(true);
        }
        // Routing is intentionally public to all database scopes.
        for (const table of [organizationDomains, ssoProviders]) {
          const rows = await tx
            .select({ organizationId: table.organizationId })
            .from(table);
          expect(rows.map((row) => row.organizationId)).toEqual(
            expect.arrayContaining(tenants),
          );
        }
      },
    );
  }
  const foreign = tenants[1]!;
  const inserts = [
    (tx: import("./client.ts").Executor) =>
      tx
        .insert(members)
        .values({ id: createId(), organizationId: foreign, userId }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(invitations).values({
        id: createId(),
        organizationId: foreign,
        email: "foreign@example.com",
        inviterId: userId,
        expiresAt: new Date(Date.now() + 60000),
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(organizationDomains).values({
        id: createId(),
        organizationId: foreign,
        domain: `${createId()}.example.com`,
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(ssoProviders).values({
        id: createId(),
        organizationId: foreign,
        providerId: createId(),
        issuer: "https://issuer.example.com",
        domain: "foreign.example.com",
      }),
  ];
  for (const insert of inserts)
    await expect(
      withDatabaseScope(
        runtime.db,
        { kind: "tenant", access: "write", organizationId: tenants[0]! },
        async (tx) => {
          await insert(tx);
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await runtime.db.select().from(members)).toEqual([]);
  expect(await runtime.db.select().from(invitations)).toEqual([]);
  expect(await runtime.db.select().from(auditEvents)).toEqual([]);
  expect(await runtime.db.select().from(auditEventSubjects)).toEqual([]);
  for (const table of [organizationDomains, ssoProviders])
    expect(
      (
        await runtime.db
          .select({ organizationId: table.organizationId })
          .from(table)
      ).map((row) => row.organizationId),
    ).toEqual(expect.arrayContaining(tenants));
  const event = await withDatabaseScope(
    runtime.db,
    { kind: "tenant", access: "write", organizationId: tenants[0]! },
    (tx) =>
      recordAuditEvent(tx, {
        organizationId: foreign,
        actorType: "system",
        actorId: "rls-proof",
        action: "rls.append",
        targetType: "user",
        targetId: userId,
        outcome: "success",
      }),
  );
  expect(
    await owner.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, event.id)),
  ).toEqual([event]);
  await expect(
    Promise.resolve(
      runtime.db.insert(auditEventSubjects).values({
        eventId: event.id,
        entityType: "user",
        entityId: userId,
        relationship: "forged",
        organizationId: foreign,
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  for (const table of [
    "members",
    "invitations",
    "organization_domains",
    "sso_providers",
    "audit_events",
    "audit_event_subjects",
  ]) {
    await owner.db.execute(
      sql`alter table ${sql.identifier(table)} disable row level security`,
    );
    try {
      await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
        "Unsafe database runtime role",
      );
    } finally {
      await owner.db.execute(
        sql`alter table ${sql.identifier(table)} enable row level security`,
      );
    }
  }
  await assertRuntimeRole(runtime.db);
});

test("policy-user access tables require an effective membership", async () => {
  const { createId } = await import("../lib/id.ts");
  const { organizations, users, members, groups } =
    await import("./schema/index.ts");
  const organizationId = createId(),
    userId = createId(),
    memberId = createId();
  await owner.db.insert(organizations).values({
    id: organizationId,
    slug: `effective-${organizationId}`,
    name: "Effective membership",
  });
  await owner.db.insert(users).values({
    id: userId,
    name: "Member",
    email: `${userId}@example.com`,
    status: "active",
  });
  await owner.db
    .insert(members)
    .values({ id: memberId, organizationId, userId });
  await owner.db.insert(groups).values({
    id: createId(),
    organizationId,
    slug: "effective",
    name: "Effective",
  });
  const rows = () =>
    withDatabaseScope(runtime.db, { kind: "policy-user", userId }, (tx) =>
      tx.select().from(groups),
    );
  expect(await rows()).toHaveLength(1);
  for (const patch of [
    { validFrom: new Date(Date.now() + 60000), validUntil: null },
    { validFrom: null, validUntil: new Date(Date.now() - 60000) },
    { validUntil: null, status: "revoked" as const, revokedAt: new Date() },
    { deletedAt: new Date() },
  ]) {
    await owner.db.update(members).set(patch).where(eq(members.id, memberId));
    expect(await rows()).toEqual([]);
  }
});
