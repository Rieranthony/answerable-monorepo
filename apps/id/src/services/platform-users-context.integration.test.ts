import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import {
  inPlatformRead,
  inPlatformUsers,
} from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import { createId } from "../lib/id.ts";
import { disableUser, enableUser, retireUserEmail } from "./users.ts";
import { revokeUserSession, revokeUserSessions } from "./sessions.ts";
import type { PlatformUsersContext } from "./platform-context.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const actor = {
  actorType: "system" as const,
  actorId: "context-test",
  requestId: "context-test",
};
const missing = createId();
const writers = [
  (context: PlatformUsersContext) => disableUser(context, missing),
  (context: PlatformUsersContext) => enableUser(context, missing),
  (context: PlatformUsersContext) => retireUserEmail(context, missing),
  (context: PlatformUsersContext) =>
    revokeUserSession(context, missing, missing),
  (context: PlatformUsersContext) => revokeUserSessions(context, missing),
];

test("global user mutations require a live users command context", async () => {
  let saved!: PlatformUsersContext;
  await inPlatformUsers(fixture.db, async (context) => {
    saved = context;
    for (const write of writers) {
      await expect(write(context)).rejects.toMatchObject({ code: "not_found" });
      await expect(write({ ...context })).rejects.toThrow("Invalid or expired");
      await expect(
        write(fixture.db as unknown as PlatformUsersContext),
      ).rejects.toThrow("Invalid or expired");
    }
  });
  for (const write of writers)
    await expect(write(saved)).rejects.toThrow("Invalid or expired");
  await inPlatformRead(fixture.db, async (read) => {
    for (const write of writers)
      await expect(
        write(read as unknown as PlatformUsersContext),
      ).rejects.toThrow("Invalid or expired");
  });
  await inTenantRead(
    fixture.db,
    fixture.tenant.organizationId,
    "configuration",
    async (tenant) => {
      for (const write of writers)
        await expect(
          write(tenant as unknown as PlatformUsersContext),
        ).rejects.toThrow("Invalid or expired");
    },
  );
});

test("a failed command callback expires its users context", async () => {
  let saved!: PlatformUsersContext;
  await expect(
    inPlatformUsers(fixture.db, async (context) => {
      saved = context;
      throw new Error("abort command");
    }),
  ).rejects.toThrow("abort command");
  for (const write of writers)
    await expect(write(saved)).rejects.toThrow("Invalid or expired");
});

test("journal exit expires saved users authorisation on commit, replay, conflict and failure", async () => {
  const { authorizePlatformUsersCommand } =
    await import("./platform-context.ts");
  const { executeOperation } = await import("./operations.ts");
  const command = {
    actorInstance: "system:lifetime-test",
    authorityScope: "platform",
    name: "lifetime-test",
    key: createId(),
    input: { value: 1 },
  };
  const saved: Awaited<ReturnType<typeof authorizePlatformUsersCommand>>[] = [];
  let mutations = 0;
  const execute = (input = command.input, fail = false) =>
    executeOperation(
      fixture.db,
      { ...command, key: fail ? `${command.key}-failure` : command.key, input },
      async (tx) => {
        const authority = await authorizePlatformUsersCommand(tx, {
          principal: { type: "root", grants: [] },
          environment: fixture.environment,
        });
        saved.push(authority);
        return authority;
      },
      async (_tx, _id, authority) =>
        authority.run(async () => {
          mutations++;
          await expect(authority.run(async () => {}, actor)).rejects.toThrow(
            "Invalid or expired",
          );
          if (fail) throw new Error("mutation failed");
          return {
            outcome: "applied",
            statusCode: 204,
            resultReference: { type: "test", id: "one" },
          };
        }, actor),
      (authority) => authority.close(),
    );
  expect((await execute()).replayed).toBe(false);
  expect((await execute()).replayed).toBe(true);
  await expect(execute({ value: 2 })).rejects.toMatchObject({
    code: "idempotency_key_reused",
  });
  await expect(execute(command.input, true)).rejects.toThrow("mutation failed");
  expect(mutations).toBe(2);
  expect(saved).toHaveLength(4);
  for (const authority of saved)
    await expect(authority.run(async () => {}, actor)).rejects.toThrow(
      "Invalid or expired",
    );
});

test("journal replay releases tenant authorisation even without a mutation callback", async () => {
  const { authorizeTenantMemberCommand, requireTenantMemberContext } =
    await import("./tenant-context.ts");
  const { executeOperation } = await import("./operations.ts");
  const contexts: Awaited<ReturnType<typeof authorizeTenantMemberCommand>>[] =
    [];
  const command = {
    actorInstance: "system:tenant-lifetime",
    authorityScope: `tenant:${fixture.tenant.organizationId}`,
    name: "tenant-lifetime",
    key: createId(),
    input: null,
  };
  const execute = () =>
    executeOperation(
      fixture.db,
      command,
      async (tx) => {
        const context = await authorizeTenantMemberCommand(tx, {
          principal: { type: "root", grants: [] },
          environment: fixture.environment,
          organizationId: fixture.tenant.organizationId,
        });
        contexts.push(context);
        return context;
      },
      async (_tx, _id, authority) =>
        authority.run(async (context) => {
          expect(requireTenantMemberContext(context)).toBe(context);
          return {
            outcome: "applied",
            statusCode: 204,
            resultReference: { type: "test", id: "one" },
          };
        }, actor),
      (authority) => authority.close(),
    );
  expect((await execute()).replayed).toBe(false);
  expect((await execute()).replayed).toBe(true);
  expect(contexts).toHaveLength(2);
  for (const context of contexts)
    await expect(context.run(async () => {}, actor)).rejects.toThrow(
      "Invalid or expired",
    );
});

test("platform write contexts protect organisation mutations and user erasure without granting users authority", async () => {
  const { inPlatformWrite } = await import("../__tests__/platform-context.ts");
  const org = await import("./organizations.ts");
  const { eraseUser } = await import("./users.ts");
  type Write = import("./platform-context.ts").PlatformWriteContext;
  const domains = await import("./domains.ts");
  const sso = await import("./sso-providers.ts");
  const groups = await import("./groups.ts");
  const grants = await import("./entitlements.ts");
  const clients = await import("./clients.ts");
  const resources = await import("./resources.ts");
  const changes = [
    (context: Write) =>
      clients.createClient(context, {
        name: "Test",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        redirectUris: [],
      }),
    (context: Write) => clients.updateClient(context, missing, {}),
    (context: Write) => clients.disableClient(context, missing),
    (context: Write) => clients.enableClient(context, missing),
    (context: Write) => clients.rotateSecret(context, missing),
    (context: Write) => clients.setOwner(context, missing, null),
    (context: Write) => clients.linkResource(context, missing, missing),
    (context: Write) => clients.unlinkResource(context, missing, missing),
    (context: Write) => clients.eraseClient(context, missing, missing),
    (context: Write) =>
      resources.createResource(context, {
        identifier: "https://missing.example",
        name: "Test",
        allowedScopes: [],
      }),
    (context: Write) => resources.updateResource(context, missing, {}),
    (context: Write) =>
      resources.disableResource(
        context,
        fixture.environment.adminResourceIdentifier,
      ),
    (context: Write) => resources.enableResource(context, missing),
    (context: Write) => resources.eraseResource(context, missing, missing),
    (context: Write) =>
      groups.createGroup(context, missing, {
        slug: "test",
        name: "Test",
      }),
    (context: Write) =>
      groups.updateGroup(context, missing, missing, { name: "Test" }),
    (context: Write) => groups.disableGroup(context, missing, missing),
    (context: Write) => groups.enableGroup(context, missing, missing),
    (context: Write) => groups.eraseGroup(context, missing, missing, missing),
    (context: Write) =>
      groups.putMember(context, missing, missing, missing, {}),
    (context: Write) => groups.removeMember(context, missing, missing, missing),
    (context: Write) =>
      grants.createEntitlement(context, missing, {
        clientId: "missing",
        scopes: [],
      }),
    (context: Write) => grants.updateEntitlement(context, missing, missing, {}),
    (context: Write) => grants.disableEntitlement(context, missing, missing),
    (context: Write) => grants.enableEntitlement(context, missing, missing),
    (context: Write) => grants.removeEntitlement(context, missing, missing),
    (context: Write) =>
      domains.createDomain(context, missing, {
        domain: "test.example.com",
      }),
    (context: Write) => domains.disableDomain(context, missing, missing),
    (context: Write) => domains.enableDomain(context, missing, missing),
    (context: Write) =>
      domains.deleteOrganizationDomain(context, missing, missing),
    (context: Write) =>
      sso.putSsoProvider(context, missing, {
        issuer: "https://test.example.com",
        domain: "test.example.com",
        oidc: { clientId: "test" },
      }),
    (context: Write) => sso.deleteSsoProvider(context, missing),
    (context: Write) =>
      org.createOrganization(context, {
        slug: createId(),
        name: "Context test",
      }),
    (context: Write) =>
      org.updateOrganization(context, missing, { name: "Missing" }),
    (context: Write) => org.disableOrganization(context, missing),
    (context: Write) => org.enableOrganization(context, missing),
    (context: Write) => org.eraseOrganization(context, missing, missing),
    (context: Write) => eraseUser(context, missing, missing),
  ];
  let saved!: Write;
  await inPlatformWrite(fixture.db, async (context) => {
    saved = context;
    const created = await org.createOrganization(context, {
      slug: createId(),
      name: "Created",
    });
    await org.eraseOrganization(context, created.id, created.id);
    for (const change of changes) {
      await expect(change({ ...context })).rejects.toThrow(
        "Invalid or expired",
      );
      await expect(change(fixture.db as unknown as Write)).rejects.toThrow(
        "Invalid or expired",
      );
    }
    for (const write of writers)
      await expect(
        write(context as unknown as PlatformUsersContext),
      ).rejects.toThrow("Invalid or expired");
  });
  for (const change of changes)
    await expect(change(saved)).rejects.toThrow("Invalid or expired");
  await inPlatformUsers(fixture.db, async (context) => {
    for (const change of changes)
      await expect(change(context as unknown as Write)).rejects.toThrow(
        "Invalid or expired",
      );
  });
  await inPlatformRead(fixture.db, async (context) => {
    for (const change of changes)
      await expect(change(context as unknown as Write)).rejects.toThrow(
        "Invalid or expired",
      );
  });
  await inTenantRead(
    fixture.db,
    fixture.tenant.organizationId,
    "directory",
    async (context) => {
      for (const change of changes)
        await expect(change(context as unknown as Write)).rejects.toThrow(
          "Invalid or expired",
        );
    },
  );
});

for (const factory of [
  "authorizePlatformUsersCommand",
  "authorizePlatformWriteCommand",
] as const) {
  test(`${factory}: actor is a frozen snapshot of authority, never metadata`, async () => {
    const authorize = (await import("./platform-context.ts"))[factory];
    const principal: import("../http/principal.ts").Principal = {
      type: "root",
      grants: [],
    };
    const metadata = {
      ...actor,
      actorType: "user" as const,
      actorId: createId(),
      operationId: createId(),
      ip: "192.0.2.1",
      userAgent: "test",
    };
    await fixture.db.transaction(async (tx) => {
      const authority = await authorize(tx, {
        principal,
        environment: fixture.environment,
      });
      Object.assign(principal, { type: "user", userId: createId() });
      try {
        await authority.run(async (context) => {
          expect(context.actor).toEqual({
            ...metadata,
            actorType: "system",
            actorId: "root",
          });
          expect(Object.isFrozen(context.actor)).toBe(true);
          metadata.requestId = "changed";
          expect(context.actor.requestId).toBe("context-test");
          expect(() =>
            Object.assign(context.actor, { actorId: "forged" }),
          ).toThrow();
        }, metadata);
      } finally {
        authority.close();
      }
    });
  });
}
