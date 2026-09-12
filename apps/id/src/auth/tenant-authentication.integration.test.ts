import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { afterBrokerRead } from "../__tests__/after-broker-read.ts";
import { databaseClock } from "../__tests__/database-clock.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import * as auditQueries from "../db/queries/audit.ts";
import { assertRuntimeRole, configureRuntimeRole } from "../db/runtime-role.ts";
import {
  accounts,
  auditEvents,
  entitlements,
  grantContexts,
  members,
  oauthClientResources,
  oauthClients,
  oauthResources,
  sessions,
  ssoProviders,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { authorizeCommand } from "../services/command-authority.ts";
import * as federationResolver from "../services/federation.ts";
import { updateWindow } from "../services/members.ts";
import {
  deleteSsoProvider,
  putSsoProvider,
} from "../services/sso-providers.ts";
import { authorizeTenantMemberCommand } from "../services/tenant-context.ts";
import { createResourceGrant } from "./create-resource-grant.ts";
import { lockResourceGrantTargets } from "./lock-resource-grant-policy.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

let fixture: AdminFixture;
let runtime: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let nativeAuth: ReturnType<typeof createAuth>;
let role: string;
let clock: ReturnType<typeof databaseClock>;
let foreignMember: string;
const clientId = "tenant-authentication-proof";
const resource = "https://resource.example/tenant-authentication";

beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_admission_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  runtime = createDatabase({
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 2,
  });
  clock = databaseClock(runtime.pool);
  await assertRuntimeRole(runtime.db);
  fixture.environment.trustedProxyCidrs = ["10.0.0.0/8"];
  nativeAuth = createAuth(runtime.db, fixture.environment);
  app = createApp({
    db: runtime.db,
    auth: nativeAuth,
    environment: fixture.environment,
  });
  foreignMember = createId();
  await fixture.db.insert(members).values({
    id: foreignMember,
    userId: fixture.principals.tenantAdmin.userId,
    organizationId: fixture.outsider.organizationId,
  });
  await fixture.db.insert(entitlements).values({
    id: createId(),
    memberId: foreignMember,
    organizationId: fixture.outsider.organizationId,
    resource: fixture.platform.adminResource,
    scopes: ["org:read", "org:write"],
  });
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    name: "Admission proof",
    organizationId: fixture.tenant.organizationId,
    grantTypes: ["authorization_code"],
    scopes: ["openid"],
    redirectUris: ["https://client.example/callback"],
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Admission proof",
    classification: "platform_shared",
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
});

afterEach(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});

async function currentSession() {
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId));
  return session!;
}

async function providerInput() {
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, fixture.tenant.organizationId),
        sql`${ssoProviders.deletedAt} is null`,
      ),
    );
  return {
    issuer: provider!.issuer,
    domain: provider!.domain,
    oidc: JSON.parse(provider!.oidcConfig!),
  };
}

async function ownGrantInput() {
  const session = await currentSession();
  return {
    userId: session.userId,
    sessionId: session.id,
    memberId: fixture.principals.tenantAdmin.memberId,
    clientId,
    resource,
    scopes: ["openid"],
  };
}

test("native session records the accepted account UUID and leaves absent upstream freshness unknown", async () => {
  fixture.issuer.enqueue({
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    email_verified: true,
  });
  await signInThroughIdp(app, {
    providerId: "tenant",
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  const session = (
    await fixture.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, fixture.principals.tenantAdmin.userId),
          sql`${sessions.upstreamAuthTime} is null`,
        ),
      )
  )[0]!;
  const [account] = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, session.userId));
  expect(session).toMatchObject({
    authenticationAccountId: account!.id,
    upstreamAuthTime: null,
  });
});

test("restricted grant creation rejects A authentication when B membership is selected", async () => {
  const session = await currentSession();
  await fixture.db
    .update(sessions)
    .set({ activeOrganizationId: fixture.outsider.organizationId })
    .where(eq(sessions.id, session.id));
  await expect(
    createResourceGrant(
      runtime.db,
      {
        userId: session.userId,
        sessionId: session.id,
        memberId: foreignMember,
        clientId,
        resource,
        scopes: ["openid"],
      },
      60,
    ),
  ).rejects.toMatchObject({ body: { error: "access_denied" } });
  expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
});

test("restricted human administration rejects foreign authority and preserves platform support", async () => {
  const foreign = await app.request(
    `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
    { headers: fixture.headers("tenantAdmin") },
  );
  expect(foreign.status).toBe(404);
  const absent = await app.request(
    `/api/admin/v1/organizations/${createId()}/groups`,
    { headers: fixture.headers("tenantAdmin") },
  );
  expect(absent.status).toBe(foreign.status);
  expect((await absent.json()).code).toBe((await foreign.json()).code);
  const support = await app.request(
    `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
    { headers: fixture.headers("platformAdmin") },
  );
  expect(support.status).toBe(200);
});

test("independently verified B account evidence admits the same global user to B", async () => {
  const userId = fixture.principals.tenantAdmin.userId;
  // Fixture for the later explicit binding journey: reserve a distinct verified identity.
  const accountId = createId();
  await fixture.db.insert(accounts).values({
    id: accountId,
    userId,
    issuer: fixture.issuer.origin,
    accountId: "deliberately-bound-b",
    providerId: "outsider",
  });
  fixture.issuer.enqueue({
    sub: "deliberately-bound-b",
    email: "bound@outsider.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000) - 120,
  });
  const signedIn = await signInThroughIdp(app, {
    providerId: "outsider",
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  expect(signedIn.location).toBe(`${fixture.trustedOrigin}/callback`);
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, fixture.outsider.organizationId));
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.authenticationProviderId, provider!.id),
      ),
    );
  expect(session).toMatchObject({
    authenticationAccountId: accountId,
  });
  const grant = await createResourceGrant(
    runtime.db,
    {
      userId,
      sessionId: session!.id,
      memberId: foreignMember,
      clientId,
      resource,
      scopes: ["openid"],
    },
    60,
  );
  expect(grant.organizationId).toBe(fixture.outsider.organizationId);
  const evidence = await withDatabaseScope(
    runtime.db,
    { kind: "grant-admission", userId, sessionId: session!.id },
    async (tx) => {
      await lockResourceGrantTargets(tx, {
        userId,
        ownerUserId: null,
        organizationId: fixture.outsider.organizationId,
        clientId,
        resource,
      });
      return tenantAuthentication(tx, {
        userId,
        sessionId: session!.id,
        organizationId: fixture.outsider.organizationId,
      });
    },
  );
  expect(evidence).toMatchObject({
    userId,
    memberId: foreignMember,
    authenticationAccountId: accountId,
    authenticationProviderId: provider!.id,
    authenticationProviderRevision: provider!.revision,
    upstreamAuthTime: session!.upstreamAuthTime,
    brokerAuthenticatedAt: session!.createdAt,
  });
  expect(evidence!.upstreamAuthTime!.getTime()).toBeLessThan(
    evidence!.brokerAuthenticatedAt.getTime(),
  );
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "auth.signin.succeeded"),
        eq(auditEvents.targetId, session!.id),
      ),
    );
  expect(event).toMatchObject({
    schemaVersion: 2,
    actorId: userId,
    organizationId: fixture.outsider.organizationId,
    data: {
      authenticationAccountId: accountId,
      authenticationProviderId: provider!.id,
      authenticationProviderRevision: provider!.revision,
      upstreamAuthTime: session!.upstreamAuthTime!.toISOString(),
    },
  });
  const headers = new Headers({
    Cookie: signedIn.cookies
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
  });
  expect(
    (
      await app.request(
        `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
        { headers },
      )
    ).status,
  ).toBe(200);
});

for (const change of [
  "secret",
  "reverted",
  "deleted",
  "recreated",
  "noop",
] as const) {
  test(`grant and human admission recheck ${change} SSO configuration`, async () => {
    const input = await providerInput();
    await inPlatformWrite(fixture.db, async (context) => {
      if (change === "deleted" || change === "recreated")
        await deleteSsoProvider(context, fixture.tenant.organizationId);
      if (change !== "deleted")
        await putSsoProvider(
          context,
          fixture.tenant.organizationId,
          change === "secret" || change === "reverted"
            ? { ...input, oidc: { ...input.oidc, clientSecret: "rotated" } }
            : input,
        );
      if (change === "reverted")
        await putSsoProvider(context, fixture.tenant.organizationId, input);
    });
    if (change === "noop")
      expect(
        (await createResourceGrant(runtime.db, await ownGrantInput(), 60))
          .organizationId,
      ).toBe(fixture.tenant.organizationId);
    else {
      await expect(
        createResourceGrant(runtime.db, await ownGrantInput(), 60),
      ).rejects.toMatchObject({ body: { error: "access_denied" } });
      expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
    }
    expect(
      (
        await app.request(
          `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups`,
          { headers: fixture.headers("tenantAdmin") },
        )
      ).status,
    ).toBe(change === "noop" ? 200 : 404);
  });
}

async function waitBlocked(blocker: number, pid: () => number) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (pid()) {
      const result = await fixture.db.execute<{ blocked: boolean }>(
        sql`select ${blocker} = any(pg_blocking_pids(${pid()})) as blocked`,
      );
      if (result.rows[0]!.blocked) return;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    "Expected the admission and provider writer to block each other",
  );
}

for (const consumer of ["grant", "human"] as const) {
  for (const order of ["admission-first", "writer-first"] as const) {
    test(`${consumer} admission and provider rotation are ordered ${order}`, async () => {
      const writer = createDatabase(fixture.environment);
      const ready = Promise.withResolvers<void>(),
        resume = Promise.withResolvers<void>();
      let admissionPid = 0,
        writerPid = 0;
      const input = await ownGrantInput();
      const provider = await providerInput();
      const admission = () =>
        runtime.db.transaction(async (tx) => {
          admissionPid = Number(
            (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!
              .pid,
          );
          if (consumer === "grant") await createResourceGrant(tx, input, 60);
          else {
            const authority = await authorizeTenantMemberCommand(tx, {
              principal: {
                type: "user",
                userId: input.userId,
                sessionId: input.sessionId,
                email: "ignored@example.com",
                grants: [],
              },
              environment: fixture.environment,
              organizationId: fixture.tenant.organizationId,
            });
            try {
              await authority.run(
                (context) =>
                  updateWindow(
                    context,
                    fixture.principals.tenantReader.memberId,
                    { validUntil: new Date("2100-01-01") },
                  ),
                { requestId: "admission-race" },
              );
            } finally {
              authority.close();
            }
          }
          if (order === "admission-first") {
            ready.resolve();
            await resume.promise;
          }
        });
      const change = () =>
        inPlatformWrite(writer.db, async (context) => {
          writerPid = Number(
            (await context.tx.execute(sql`select pg_backend_pid() as pid`))
              .rows[0]!.pid,
          );
          await putSsoProvider(context, fixture.tenant.organizationId, {
            ...provider,
            oidc: { ...provider.oidc, clientSecret: "rotated" },
          });
          if (order === "writer-first") {
            ready.resolve();
            await resume.promise;
          }
        });
      const settle = (work: Promise<unknown>) =>
        work.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      const first = settle(
        order === "admission-first" ? admission() : change(),
      );
      await Promise.race([
        ready.promise,
        first.then((result) => {
          throw new Error(
            `First transaction ended early: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const second = settle(
        order === "admission-first" ? change() : admission(),
      );
      try {
        await waitBlocked(
          order === "admission-first" ? admissionPid : writerPid,
          () => (order === "admission-first" ? writerPid : admissionPid),
        );
      } finally {
        resume.resolve();
        await Promise.all([first, second]);
        await writer.close();
      }
      expect(await first).toEqual({ ok: true });
      expect(await second).toMatchObject(
        order === "admission-first"
          ? { ok: true }
          : {
              ok: false,
              error:
                consumer === "grant"
                  ? { body: { error: "access_denied" } }
                  : { code: "insufficient_scope" },
            },
      );
      const grants = await fixture.db.select().from(grantContexts);
      expect(grants).toHaveLength(
        consumer === "grant" && order === "admission-first" ? 1 : 0,
      );
      if (grants.length) expect(grants[0]!.revokedAt).toBeInstanceOf(Date);
      const events = await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.requestId, "admission-race"));
      expect(events).toHaveLength(
        consumer === "human" && order === "admission-first" ? 1 : 0,
      );
    });
  }
  test(`${consumer} admission rechecks expiry after waiting for the native provider lock`, async () => {
    const input = await ownGrantInput();
    await fixture.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.id, input.sessionId));
    const writer = createDatabase(fixture.environment);
    const ready = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let blocker = 0,
      pendingPid = 0;
    const held = writer.db.transaction(async (tx) => {
      blocker = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      await tx
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.organizationId, fixture.tenant.organizationId))
        .for("update");
      ready.resolve();
      await resume.promise;
    });
    await ready.promise;
    const pending = runtime.db
      .transaction(async (tx) => {
        pendingPid = Number(
          (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
        );
        if (consumer === "grant") return createResourceGrant(tx, input, 60);
        return authorizeCommand(
          tx,
          {
            type: "user",
            userId: input.userId,
            sessionId: input.sessionId,
            email: "ignored@example.com",
            grants: [],
          },
          fixture.environment,
          {
            platform: "platform:read",
            tenant: {
              organizationId: fixture.tenant.organizationId,
              scope: "org:read",
            },
          },
        );
      })
      .then(
        () => ({ allowed: true }),
        (error: unknown) => ({ allowed: false, error }),
      );
    try {
      await waitBlocked(blocker, () => pendingPid);
      clock.set(new Date(Date.now() + 120_000));
    } finally {
      resume.resolve();
      await held;
      await writer.close();
    }
    expect(await pending).toMatchObject({
      allowed: false,
      error:
        consumer === "grant"
          ? { body: { error: "access_denied" } }
          : { code: "unauthenticated" },
    });
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  });
}

test("same-key human replay rechecks current SSO after middleware admission", async () => {
  const headers = fixture.headers("tenantAdmin");
  const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
  expect((await app.request(path, { method: "DELETE", headers })).status).toBe(
    204,
  );
  const provider = await providerInput();
  const original = runtime.db.transaction.bind(runtime.db);
  const hook = spyOn(runtime.db, "transaction").mockImplementation(
    afterBrokerRead(original, (async (...args: Parameters<typeof original>) => {
      await inPlatformWrite(fixture.db, (context) =>
        putSsoProvider(context, fixture.tenant.organizationId, {
          ...provider,
          oidc: { ...provider.oidc, clientSecret: "rotated" },
        }),
      );
      return original(...args);
    }) as typeof original),
  );
  try {
    expect(
      (await app.request(path, { method: "DELETE", headers })).status,
    ).toBe(403);
  } finally {
    hook.mockRestore();
  }
  fixture.issuer.enqueue({
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
  });
  const fresh = await signInThroughIdp(app, {
    providerId: "tenant",
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  expect(fresh.location).toBe(`${fixture.trustedOrigin}/callback`);
  headers.set(
    "Cookie",
    fresh.cookies.map((cookie) => cookie.split(";", 1)[0]).join("; "),
  );
  expect((await app.request(path, { method: "DELETE", headers })).status).toBe(
    204,
  );
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "member.removed"),
          eq(auditEvents.targetId, fixture.principals.tenantReader.memberId),
        ),
      ),
  ).toHaveLength(1);
});

test("human permissions expiring during a provider lock wait cannot authorise a command", async () => {
  const input = await ownGrantInput();
  await fixture.db
    .update(entitlements)
    .set({ validUntil: new Date(Date.now() + 60_000) })
    .where(eq(entitlements.memberId, input.memberId));
  const writer = createDatabase(fixture.environment);
  const ready = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let blocker = 0,
    pendingPid = 0;
  const held = writer.db.transaction(async (tx) => {
    blocker = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    await tx
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, fixture.tenant.organizationId))
      .for("update");
    ready.resolve();
    await resume.promise;
  });
  await ready.promise;
  const pending = runtime.db
    .transaction(async (tx) => {
      pendingPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      return authorizeCommand(
        tx,
        {
          type: "user",
          userId: input.userId,
          sessionId: input.sessionId,
          email: "ignored@example.com",
          grants: [],
        },
        fixture.environment,
        {
          platform: "platform:read",
          tenant: {
            organizationId: fixture.tenant.organizationId,
            scope: "org:read",
          },
        },
      );
    })
    .then(
      () => ({ allowed: true }),
      (error: unknown) => ({ allowed: false, error }),
    );
  try {
    await waitBlocked(blocker, () => pendingPid);
    clock.set(new Date(Date.now() + 120_000));
  } finally {
    resume.resolve();
    await held;
    await writer.close();
  }
  expect(await pending).toMatchObject({
    allowed: false,
    error: { code: "insufficient_scope" },
  });
});

for (const value of [null, "1700000000", -1, 1.5, 9999999999999]) {
  test(`native SSO rejects invalid upstream auth_time ${JSON.stringify(value)}`, async () => {
    const previous = await fixture.db
      .select({ id: sessions.id })
      .from(sessions);
    fixture.issuer.enqueue({
      sub: "new-subject",
      email: "new@tenant.example.com",
      email_verified: true,
      auth_time: value,
    });
    const result = await signInThroughIdp(app, {
      providerId: "tenant",
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    expect(new URL(result.location!).searchParams.get("error")).toBe(
      "invalid_auth_time",
    );
    expect(await fixture.db.select({ id: sessions.id }).from(sessions)).toEqual(
      previous,
    );
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, "new-subject")),
    ).toHaveLength(0);
  });
}

for (const fault of ["missing-account", "substituted-user"] as const) {
  test(`native provenance failure ${fault} rolls back without a sign-in success`, async () => {
    const previous = await fixture.db
      .select({ id: sessions.id })
      .from(sessions);
    const events = await fixture.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "auth.signin.succeeded"));
    const originalResolver = federationResolver.resolveFederatedUser;
    const { internalAdapter } = await nativeAuth.$context;
    const originalCreate = internalAdapter.createSession.bind(internalAdapter);
    const hook =
      fault === "missing-account"
        ? spyOn(federationResolver, "resolveFederatedUser").mockImplementation(
            async (input, database) => {
              const result = await originalResolver(input, database);
              await database.delete({
                model: "account",
                where: [
                  { field: "issuer", value: input.accountKey.issuer },
                  { field: "accountId", value: input.accountKey.accountId },
                ],
              });
              return result;
            },
          )
        : spyOn(internalAdapter, "createSession").mockImplementation(
            (_userId, ...rest) =>
              originalCreate(fixture.principals.outsider.userId, ...rest),
          );
    fixture.issuer.enqueue({
      sub: "new-subject",
      email: "new@tenant.example.com",
      email_verified: true,
    });
    try {
      const result = await signInThroughIdp(app, {
        providerId: "tenant",
        callbackURL: `${fixture.trustedOrigin}/callback`,
      });
      expect(new URL(result.location!).searchParams.get("error")).toBe(
        fault === "missing-account"
          ? "SSO_USER_RESOLUTION_FAILED"
          : "authentication_origin_mismatch",
      );
    } finally {
      hook.mockRestore();
    }
    expect(await fixture.db.select({ id: sessions.id }).from(sessions)).toEqual(
      previous,
    );
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, "new-subject")),
    ).toHaveLength(0);
    expect(
      await fixture.db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "auth.signin.succeeded")),
    ).toEqual(events);
  });
}

for (const missing of [
  "origin",
  "account",
  "account-provider",
  "member",
  "user",
] as const) {
  test(`missing origin or deleted ${missing} cannot establish authority`, async () => {
    const input = await ownGrantInput();
    if (missing === "origin") {
      const [session] = await fixture.db
        .insert(sessions)
        .values({
          id: createId(),
          token: createId(),
          userId: input.userId,
          expiresAt: new Date(Date.now() + 60000),
        })
        .returning();
      input.sessionId = session!.id;
    } else if (missing === "account-provider")
      await fixture.db
        .update(accounts)
        .set({ providerId: "outsider" })
        .where(eq(accounts.userId, input.userId));
    else if (missing === "account")
      await fixture.db
        .update(accounts)
        .set({
          deletedAt: new Date(),
          accessToken: null,
          refreshToken: null,
          idToken: null,
        })
        .where(eq(accounts.userId, input.userId));
    else if (missing === "member")
      await fixture.db
        .update(members)
        .set({
          deletedAt: new Date(),
          status: "revoked",
          revokedAt: new Date(),
        })
        .where(eq(members.id, input.memberId));
    else
      await fixture.db.execute(
        sql`update users set deleted_at=now(), status='disabled', disabled_at=now() where id=${input.userId}`,
      );
    await expect(
      createResourceGrant(runtime.db, input, 60),
    ).rejects.toMatchObject({ body: { error: "access_denied" } });
    await expect(
      runtime.db.transaction((tx) =>
        authorizeCommand(
          tx,
          {
            type: "user",
            userId: input.userId,
            sessionId: input.sessionId,
            email: "untrusted@example.com",
            grants: [],
          },
          fixture.environment,
          {
            platform: "platform:read",
            tenant: {
              organizationId: fixture.tenant.organizationId,
              scope: "org:read",
            },
          },
        ),
      ),
    ).rejects.toMatchObject({
      code: missing === "user" ? "unauthenticated" : "insufficient_scope",
    });
  });
}

test("native sign-in commits the client address with session and audit", async () => {
  fixture.issuer.enqueue({
    sub: "ip-proof",
    email: "ip@tenant.example.com",
    email_verified: true,
  });
  const result = await signInThroughIdp(
    app,
    { providerId: "tenant", callbackURL: `${fixture.trustedOrigin}/callback` },
    undefined,
    { "x-forwarded-for": "192.0.2.44, 10.0.0.1", "x-request-id": "ip-proof" },
  );
  expect(result.response.status).toBe(302);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.requestId, "ip-proof"));
  expect(event).toMatchObject({
    action: "auth.signin.succeeded",
    ip: "192.0.2.44",
    organizationId: fixture.tenant.organizationId,
  });
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, event!.targetId!));
  expect(session).toMatchObject({
    ipAddress: "192.0.2.44",
    userId: event!.actorId,
  });
});

test("session reads do not emit a signed JWT header", async () => {
  const response = await app.request("/auth/get-session", {
    headers: fixture.headers("tenantAdmin"),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveProperty("session.id");
  expect(response.headers.get("set-auth-jwt")).toBeNull();
  expect(
    response.headers.get("access-control-expose-headers") ?? "",
  ).not.toContain("set-auth-jwt");
});

test("sign-in audit failure rolls back the new session", async () => {
  const previous = await fixture.db.select({ id: sessions.id }).from(sessions);
  fixture.issuer.enqueue({
    sub: "audit-failure",
    email: "audit@tenant.example.com",
    email_verified: true,
  });
  const original = auditQueries.recordAuditEvent;
  const failure = spyOn(auditQueries, "recordAuditEvent").mockImplementation(
    async (db, event) => {
      if (event.action === "auth.signin.succeeded")
        throw new Error("synthetic audit failure");
      return original(db, event);
    },
  );
  try {
    const result = await signInThroughIdp(app, {
      providerId: "tenant",
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toMatchObject({
      code: "authentication_unavailable",
    });
  } finally {
    failure.mockRestore();
  }
  expect(await fixture.db.select({ id: sessions.id }).from(sessions)).toEqual(
    previous,
  );
});
