import { approveAdminCapability } from "../__tests__/capabilities.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import { type DatabaseConnection } from "./client.ts";
import {
  closeRuntimeRole,
  openRuntimeRole,
} from "../__tests__/runtime-role.ts";

let owner: DatabaseConnection;
let runtime: DatabaseConnection;
const roleName = `id_test_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
const environment = testEnvironment();
beforeAll(async () => {
  ({ owner, runtime } = await openRuntimeRole(environment, roleName));
});
afterAll(() => closeRuntimeRole({ owner, runtime }, roleName));
test("access queries use issued tenant contexts on a restricted connection", async () => {
  const { organizations, users, members, oauthResources, entitlements } =
    await import("./schema/index.ts");
  const { memberAccess, targetAccess } = await import("./queries/access.ts");
  const { requireTenantMemberAccessContext } =
    await import("../services/tenant-context.ts");
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
        // The query reads the context it is given; the registry refuses copies.
        expect(() => requireTenantMemberAccessContext({ ...context })).toThrow(
          "Invalid or expired",
        );
      },
    );
    await inTenantRead(runtime.db, tenant.id, "directory", async (context) => {
      const page = await targetAccess(context, { resource }, { limit: 10 });
      expect(page.items.map((row) => row.memberId)).toEqual([tenant.memberId]);
      expect(
        (await memberQueries.listMembers(context, { limit: 10 })).items.map(
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
      ).toEqual({ removedGrants: [], softDeletedAssignments: [] });
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
          (await groupQueries.listGroups(context, { limit: 10 })).items.map(
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
          ).items.map((row) => row.memberId),
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
          ).items.map((row) => row.id),
        ).toEqual([tenant.entitlement.id]);
        expect(
          await entitlementQueries.findEntitlement(
            context,
            foreign.entitlement.id,
          ),
        ).toBeNull();
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
      ).items
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
  const { requireTenantHistoryContext } =
    await import("../services/tenant-context.ts");
  const { requirePlatformReadContext } =
    await import("../services/platform-context.ts");
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
        action: "user.enabled",
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
        expect(requireTenantHistoryContext(context)).toBe(context);
        expect(() => requireTenantHistoryContext({ ...context })).toThrow(
          "Invalid or expired",
        );
        expect(() => requirePlatformReadContext(context as never)).toThrow(
          "Invalid or expired",
        );
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
    expect(requirePlatformReadContext(context)).toBe(context);
    expect(() => requirePlatformReadContext({ ...context })).toThrow(
      "Invalid or expired",
    );
  });
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
        (await queries.listOrganizationDomains(context, { limit: 10 })).items,
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
      (await queries.listOrganizations(context, { limit: 10, q: prefix })).items
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
      ).items.map((row) => row.id),
    ).toEqual([userId]);
    const user = await userQueries.findUser(context, userId);
    expect(user?.memberships.map((row) => row.organizationId).sort()).toEqual(
      tenantIds.sort(),
    );
    expect(user?.sessionCount).toBe(1);
    expect(JSON.stringify(user)).not.toContain("-secret");
    const { items: rows } = await sessionQueries.listUserSessions(
      context,
      userId,
      { limit: 10 },
    );
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
      (await sessionQueries.listUserSessions(context, userId, { limit: 10 }))
        .items,
    ).toEqual([]);
    expect(
      (
        await sessionQueries.listUserSessions(context, otherId, { limit: 10 })
      ).items.map((row) => row.id),
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
      (await queries.listResources(context, { limit: 10, q: prefix })).items
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
    const { items: rows } = await queries.listClients(context, {
      limit: 10,
      q: prefix,
    });
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
  const { insertGrantContext, insertOriginSession } =
    await import("../__tests__/grants.ts");
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
  // A grant needs a session its tenant's provider authenticated.
  const origins = new Map<string, string>();
  const origin = async (tenantIndex: number, userIndex: number) => {
    const key = `${tenantIndex}:${userIndex}`;
    if (!origins.has(key))
      origins.set(
        key,
        (
          await insertOriginSession(owner.db, {
            userId: userIds[userIndex]!,
            organizationId: tenantIds[tenantIndex]!,
            createdAt: authTime,
          })
        ).id,
      );
    return origins.get(key)!;
  };
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
    await insertGrantContext(owner.db, {
      id,
      organizationId: tenantIds[tenantIndex]!,
      memberId,
      userId: userIds[userIndex]!,
      clientInstanceId: clientIds[0]!,
      authenticationSessionId: await origin(tenantIndex, userIndex),
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
      authenticationSessionId: await origin(0, 0),
    },
    {
      organizationId: tenantIds[1]!,
      memberId: grants[2]!.memberId,
      userId: userIds[0]!,
      clientInstanceId: clientIds[0]!,
      resourceInstanceId: resourceIds[1]!,
      authenticationSessionId: await origin(1, 0),
    },
    {
      organizationId: tenantIds[0]!,
      memberId: grants[1]!.memberId,
      userId: userIds[1]!,
      clientInstanceId: clientIds[1]!,
      resourceInstanceId: resourceIds[1]!,
      authenticationSessionId: await origin(0, 1),
    },
    {
      organizationId: tenantIds[1]!,
      memberId: otherMemberId,
      userId: userIds[1]!,
      clientInstanceId: clientIds[1]!,
      resourceInstanceId: resourceIds[0]!,
      authenticationSessionId: await origin(1, 1),
    },
  ];
  for (const operation of [
    "revokeUser",
    "revokeSession",
    "revokeErasedUser",
    "revokeOrganization",
    "revokeResource",
    "revokeClient",
  ] as const) {
    const ids = targets.map(() => createId());
    for (const [index, target] of targets.entries())
      await insertGrantContext(owner.db, {
        ...target,
        id: ids[index]!,
        requestedScopes: ["openid"],
        expiresAt: new Date(Date.now() + 60000),
      });
    const expected = ids.filter((_, index) =>
      operation === "revokeSession"
        ? index === 0
        : operation === "revokeUser" || operation === "revokeErasedUser"
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
                targets[0]!.authenticationSessionId,
              ),
            )
          : inPlatformWrite(runtime.db, (context) => {
              switch (operation) {
                case "revokeErasedUser":
                  return grantQueries.revokeErasedUserGrantContexts(
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
