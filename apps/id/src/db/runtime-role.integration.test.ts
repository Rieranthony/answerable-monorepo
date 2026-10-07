import { withDatabaseScope } from "./isolation.ts";
import {
  approveAdminCapability,
  approveMachineCapability,
} from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import {
  createClient as createClientImplementation,
  linkResource as linkResourceImplementation,
} from "../services/clients.ts";
const createClient = platformWriteService(createClientImplementation);
const linkResource = platformWriteService(linkResourceImplementation);
import { type DatabaseConnection } from "./client.ts";
import { auditEvents, oauthResources } from "./schema/index.ts";
import { configureRuntimeRole, assertRuntimeRole } from "./runtime-role.ts";
import { openRuntimeRole } from "../__tests__/runtime-role.ts";

let roles: Awaited<ReturnType<typeof openRuntimeRole>>;
let owner: DatabaseConnection;
let runtime: DatabaseConnection;
let roleName: string;
const ownerRole = `id_test_owner_${crypto.randomUUID().replaceAll("-", "")}`;
const environment = testEnvironment();
beforeAll(async () => {
  roles = await openRuntimeRole(environment);
  ({ owner, runtime, role: roleName } = roles);
});
afterAll(() => roles?.close());
test("real runtime login can bootstrap, restart, audit and issue a machine token", async () => {
  await configureRuntimeRole(owner.db, roleName);
  await assertRuntimeRole(runtime.db);
  await expect(assertRuntimeRole(owner.db)).rejects.toThrow(
    "Unsafe database runtime role",
  );
  const identity = await runtime.db.execute(sql`select current_user as name`);
  expect(identity.rows).toEqual([{ name: roleName }]);
  const actor = systemActor("runtime-role-test");
  const options = {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Platform",
    adminResourceIdentifier: environment.adminResourceIdentifier,
  };
  const seeded = await bootstrap(runtime.db, actor, options);
  // A later start restores the admin resource's definition under the same role.
  await owner.db
    .update(oauthResources)
    .set({ accessTokenTtl: 60 })
    .where(eq(oauthResources.id, seeded.resourceId));
  expect(await bootstrap(runtime.db, actor, options)).toEqual({
    ...seeded,
    created: false,
  });
  const [resource] = await owner.db
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.id, seeded.resourceId));
  expect(resource!.accessTokenTtl).toBe(600);
  const client = await createClient(runtime.db, actor, {
    clientId: "runtime-machine",
    name: "Runtime",
    organizationId: seeded.organizationId,
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
    organizationId: seeded.organizationId,
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
      schemaVersion: 1,
      data: {
        decision: {
          allowed: true,
          reason: "approved",
          grantType: "client_credentials",
          subjectType: "client",
          organization: { id: seeded.organizationId },
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
      organizationId: seeded.organizationId,
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
    "truncate audit_events cascade",
    "delete from audit_event_users",
    "insert into audit_event_users select * from audit_event_users",
    "delete from grant_contexts",
    "alter table audit_events disable trigger all",
    "create table public.runtime_forgery (id int)",
    "select capture_audit_subjects()",
    "set role answerable",
  ])
    await expect(
      Promise.resolve(runtime.db.execute(sql.raw(command))),
    ).rejects.toThrow();
});

test("a temporary table cannot shadow a guard, and the runtime cannot create one", async () => {
  const { createId } = await import("../lib/id.ts");
  const { organizations, oauthResources } = await import("./schema/index.ts");
  await configureRuntimeRole(owner.db, roleName);
  await expect(
    Promise.resolve(
      runtime.db.execute(sql`create temp table runtime_shadow (id integer)`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  const database = sql.identifier(
    (
      await owner.db.execute<{ name: string }>(
        sql`select current_database() as name`,
      )
    ).rows[0]!.name,
  );
  const role = sql.identifier(roleName);
  await owner.db.execute(
    sql`grant temporary on database ${database} to ${role}`,
  );
  try {
    await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
      "Unsafe database runtime role",
    );
    // Even a role that can create temporary tables reaches the real relations.
    const [owning, other] = [createId(), createId()];
    await owner.db.insert(organizations).values([
      { id: owning, slug: "shadow-owner", name: "Owner" },
      { id: other, slug: "shadow-other", name: "Other" },
    ]);
    const privateResource = "https://shadow.example/private";
    const sharedResource = "https://shadow.example/shared";
    await owner.db.insert(oauthResources).values([
      {
        id: createId(),
        identifier: privateResource,
        name: "Private",
        classification: "tenant_owned",
        organizationId: owning,
      },
      { id: createId(), identifier: sharedResource, name: "Shared" },
    ]);
    const shadowed = (statements: SQL[]) =>
      withDatabaseScope(
        runtime.db,
        { kind: "platform", access: "write" },
        async (tx) => {
          for (const statement of statements) await tx.execute(statement);
        },
      );
    await expect(
      shadowed([
        sql`create temp table oauth_resources (identifier text, classification text, organization_id uuid) on commit drop`,
        sql`insert into entitlements (id, organization_id, resource, scopes) values (${createId()}, ${other}, ${privateResource}, array['read'])`,
      ]),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      shadowed([
        sql`create temp table system_bindings (organization_id uuid, resource_instance_id uuid) on commit drop`,
        sql`create temp table oauth_resources (id uuid, identifier text) on commit drop`,
        sql`insert into pg_temp.system_bindings values (${other}, ${owning})`,
        sql`insert into pg_temp.oauth_resources values (${owning}, ${sharedResource})`,
        sql`insert into organization_capabilities (id, organization_id, resource, grant_kind, scopes) values (${createId()}, ${other}, ${sharedResource}, 'admin_session', array['platform:write'])`,
      ]),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  } finally {
    await owner.db.execute(
      sql`revoke temporary on database ${database} from ${role}`,
    );
  }
  await assertRuntimeRole(runtime.db);
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

test("runtime startup refuses disabled tenant or grant-context RLS", async () => {
  for (const table of ["groups", "grant_contexts"]) {
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
  const { listUserAuditEvents } = await import("../__tests__/audit-queries.ts");
  const { recordAuditEvent } = await import("./queries/audit.ts");
  const affected = crypto.randomUUID();
  const row = await recordAuditEvent(runtime.db, {
    actorType: "system",
    actorId: "root",
    action: "user.erased",
    targetType: "user",
    targetId: crypto.randomUUID(),
    outcome: "success",
    data: {
      effects: {
        deletedAccessTokens: [{ id: crypto.randomUUID(), userId: affected }],
      },
    },
  });
  expect(
    (await listUserAuditEvents(runtime.db, affected, {}, { limit: 10 })).items,
  ).toEqual([{ ...row, occurredAt: expect.any(Date) }]);
  await assertRuntimeRole(runtime.db);
});

test("runtime lifecycle audit indexes recorded users without direct subject write privileges", async () => {
  const { listUserAuditEvents } = await import("../__tests__/audit-queries.ts");
  const { recordAuditEvent } = await import("./queries/audit.ts");
  const affected = crypto.randomUUID();
  const expected = [];
  for (const targetType of ["client", "resource", "organization"] as const) {
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
          action: (
            {
              client: ["client.grants_revoked", "client.grants_erased"],
              resource: ["resource.disabled", "resource.erased"],
              organization: ["organization.disabled", "organization.erased"],
            } as const
          )[targetType][Number(erased)]!,
          outcome: "success",
          data:
            targetType === "client"
              ? { grantContexts: effects }
              : erased
                ? { revokedGrantContexts: effects }
                : { effects: { revokedGrantContexts: effects } },
        }),
      );
    }
  }
  expect(
    (await listUserAuditEvents(runtime.db, affected, {}, { limit: 10 })).items,
  ).toEqual(
    expected.reverse().map((row) => ({ ...row, occurredAt: expect.any(Date) })),
  );
  await assertRuntimeRole(runtime.db);
});
