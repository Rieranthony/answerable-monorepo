import { inTenant } from "../__tests__/tenant-command.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { putSsoProvider, deleteSsoProvider } from "./sso-providers.ts";
import { remove as removeMembership, reinstate } from "./members.ts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createApp, type App } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createSsoOriginBoundary } from "../auth/sso-origin.ts";
import { authDatabaseAdapter } from "../auth/database-adapter.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  startOidcIssuer,
  type OidcClaims,
  type OidcIssuer,
} from "../__tests__/oidc-issuer.ts";
import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { assertRuntimeRole, configureRuntimeRole } from "../db/runtime-role.ts";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import {
  auditEvents,
  accounts,
  members,
  organizations,
  ssoProviders,
  users,
  sessions,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const callbackURL = "https://chat.example.com/callback";
const errorCallbackURL = "https://chat.example.com/error";
const entraIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

let issuer: OidcIssuer;
let connection: DatabaseConnection;
let runtime: DatabaseConnection;
const roleName = `id_test_sso_${crypto.randomUUID().replaceAll("-", "")}`;
let app: App;
let beforeTokenResponse: (() => Promise<void>) | undefined;

beforeAll(async () => {
  assertDisposableTestDatabase("native SSO runtime-role proof");
  issuer = await startOidcIssuer({
    refreshToken: "synthetic-federation-refresh-proof",
    beforeTokenResponse: async () => {
      await beforeTokenResponse?.();
    },
  });
  const environment = testEnvironment({
    trustedOrigins: [issuer.origin, new URL(callbackURL).origin],
  });
  connection = createDatabase({ ...environment, databasePoolMax: 3 });
  await configureRuntimeRole(connection.db, roleName);
  const password = crypto.randomUUID().replaceAll("-", "");
  await connection.db.execute(
    sql.raw(`alter role "${roleName}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = roleName;
  url.password = password;
  runtime = createDatabase({
    ...environment,
    databaseUrl: url.toString(),
    databasePoolMax: 1,
  });
  app = createApp({
    auth: createAuth(runtime.db, environment),
    db: runtime.db,
    environment,
  });
});

beforeEach(async () => {
  beforeTokenResponse = undefined;
  issuer.reset();
  await connection.db.execute(sql`
    truncate table
      audit_events, sso_providers,
      organization_domains,
      members,
      sessions,
      accounts,
      verifications,
      organizations,
      users
    cascade
  `);
});

afterAll(async () => {
  issuer.stop();
  await runtime?.close();
  await connection.db.execute(sql`drop owned by ${sql.identifier(roleName)}`);
  await connection.db.execute(sql`drop role ${sql.identifier(roleName)}`);
  await connection.close();
});

async function seedProvider({
  slug = "contoso",
  domain = "contoso.com",
  providerIssuer = entraIssuer,
  endpoints = true,
}: {
  slug?: string;
  domain?: string;
  providerIssuer?: string;
  endpoints?: boolean;
} = {}) {
  const [organization] = await connection.db
    .insert(organizations)
    .values({ id: createId(), name: slug, slug })
    .returning();
  await createOrganizationDomain(connection.db, {
    organizationId: organization!.id,
    domain,
  });
  await createSsoProvider(connection.db, {
    organizationId: organization!.id,
    providerId: slug,
    issuer: providerIssuer,
    domain,
    oidc: {
      clientId: `${slug}-client`,
      clientSecret: "secret",
      ...(endpoints
        ? {
            authorizationEndpoint: `${issuer.origin}/authorize`,
            tokenEndpoint: `${issuer.origin}/token`,
            jwksEndpoint: `${issuer.origin}/jwks`,
          }
        : {}),
    },
  });
  return organization!;
}

function entraClaims(overrides: Partial<OidcClaims> = {}): OidcClaims {
  return {
    sub: "entra-subject",
    oid: "entra-object",
    tid: tenantId,
    email: "person@contoso.com",
    name: "Federated Person",
    iss: entraIssuer,
    ...overrides,
  };
}

async function signIn(providerId = "contoso") {
  return signInThroughIdp(app, {
    providerId,
    callbackURL,
    errorCallbackURL,
  });
}

function errorCode(location: string | null): string | null {
  return location ? new URL(location).searchParams.get("error") : null;
}

async function insertUser(
  email: string,
  status: "inert" | "active" | "disabled",
) {
  const id = createId();
  const [user] = await connection.db
    .insert(users)
    .values({
      id,
      name: "Existing Person",
      email,
      status,
      disabledAt: status === "disabled" ? new Date() : null,
    })
    .returning();
  return user!;
}

describe("integration: federated sign-in", () => {
  test("repeated migration preserves native sessions, identity and encrypted upstream tokens", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims());
    const first = await signIn();
    expect(first.location).toBe(callbackURL);
    const identities = await connection.db.select().from(accounts);
    const beforeSessions = await connection.db.select().from(sessions);
    const cookie = first.cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    await runMigrations(connection.db);
    expect(await connection.db.select().from(accounts)).toEqual(identities);
    expect(await connection.db.select().from(sessions)).toEqual(beforeSessions);
    const current = await app.request("/auth/get-session", {
      headers: { Cookie: cookie },
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      session: { id: beforeSessions[0]!.id, userId: identities[0]!.userId },
      user: { id: identities[0]!.userId },
    });
    issuer.enqueue(entraClaims());
    expect((await signIn()).location).toBe(callbackURL);
    const rows = await connection.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: identities[0]!.id,
      userId: identities[0]!.userId,
    });
    for (const field of ["accessToken", "refreshToken", "idToken"] as const)
      expect(rows[0]![field]).toStartWith("$ba$1$");
  });
  test("legacy plaintext fails native sign-in without replacing the account or creating a session", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims());
    expect((await signIn()).location).toBe(callbackURL);
    const [initial] = await connection.db.select().from(accounts);
    await connection.db
      .update(accounts)
      .set({ accessToken: "synthetic-legacy-plaintext" })
      .where(eq(accounts.id, initial!.id));
    const [before] = await connection.db.select().from(accounts);
    issuer.enqueue(entraClaims());
    const failed = await signIn();
    expect(failed.response.status).toBe(302);
    expect(errorCode(failed.location)).toBe("SSO_USER_RESOLUTION_FAILED");
    expect(failed.location).not.toContain("synthetic-legacy-plaintext");
    expect(await connection.db.select().from(accounts)).toEqual([before!]);
    expect(await connection.db.select().from(sessions)).toHaveLength(1);
    expect(await connection.db.select().from(users)).toHaveLength(1);
    expect(await connection.db.select().from(members)).toHaveLength(1);
  });
  test("missing upstream storage keys cannot commit a native SSO identity or session", async () => {
    await seedProvider();
    const environment = testEnvironment({
      upstreamTokenSecrets: undefined,
      trustedOrigins: [issuer.origin, new URL(callbackURL).origin],
    });
    const auth = createAuth(runtime.db, environment);
    const unavailableApp = createApp({ auth, db: runtime.db, environment });
    issuer.enqueue(entraClaims());
    const result = await signInThroughIdp(unavailableApp, {
      providerId: "contoso",
      callbackURL,
      errorCallbackURL,
    });
    expect(result.location).not.toBe(callbackURL);
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({
      code: "authentication_unavailable",
      message: "Authentication is temporarily unavailable",
    });
    expect(await connection.db.select().from(accounts)).toHaveLength(0);
    expect(await connection.db.select().from(users)).toHaveLength(0);
    expect(await connection.db.select().from(sessions)).toHaveLength(0);
    expect(await connection.db.select().from(members)).toHaveLength(0);
  });
  test("native SSO supports encrypted account fields on first and repeated sign-in", async () => {
    await seedProvider();
    const environment = testEnvironment({
      trustedOrigins: [issuer.origin, new URL(callbackURL).origin],
    });
    const auth = createAuth(runtime.db, environment);
    const protectedApp = createApp({ auth, db: runtime.db, environment });
    let accountId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      issuer.enqueue(entraClaims());
      const result = await signInThroughIdp(protectedApp, {
        providerId: "contoso",
        callbackURL,
        errorCallbackURL,
      });
      expect(errorCode(result.location)).toBeNull();
      expect(result.location).toBe(callbackURL);
      const rows = await connection.db.select().from(accounts);
      expect(rows).toHaveLength(1);
      const stored = rows[0]!;
      if (accountId) expect(stored.id).toBe(accountId);
      accountId = stored.id;
      const { adapter } = await auth.$context;
      const decoded = await adapter.findOne<Record<string, string>>({
        model: "account",
        where: [{ field: "id", value: stored.id }],
      });
      for (const field of ["accessToken", "refreshToken", "idToken"] as const) {
        expect(stored[field]).toBeString();
        expect(stored[field]).not.toBe(decoded![field]);
        expect(stored[field]).toStartWith("$ba$1$");
      }
      expect(decoded!.refreshToken).toBe("synthetic-federation-refresh-proof");
      expect(decoded!.idToken).toMatch(/^eyJ/);
      expect(stored.issuer).toBe(entraIssuer);
      expect(stored.accountId).toBe("entra-subject");
    }
    expect(await connection.db.select().from(sessions)).toHaveLength(2);
  });
  test("native SSO runs through a real restricted login and reuses an unscoped connection", async () => {
    await assertRuntimeRole(runtime.db);
    expect(
      (await runtime.db.execute(sql`select current_user as name`)).rows,
    ).toEqual([{ name: roleName }]);
    await seedProvider();
    for (const attempt of ["denied", "accepted"] as const) {
      issuer.enqueue(entraClaims(attempt === "denied" ? { acct: 1 } : {}));
      const result = await signIn();
      expect(errorCode(result.location)).toBe(
        attempt === "denied" ? "guest_account" : null,
      );
      const scope = await runtime.db.execute(
        sql`select
          nullif(current_setting('answerable.scope', true), '') as scope,
          nullif(current_setting('answerable.tenant', true), '') as tenant,
          nullif(current_setting('answerable.subject', true), '') as subject`,
      );
      expect(scope.rows).toEqual([
        { scope: null, tenant: null, subject: null },
      ]);
    }
    expect(await connection.db.select().from(sessions)).toHaveLength(1);
  });
  for (const selection of [
    { organizationSlug: "contoso" },
    { email: "person@contoso.com" },
    { email: "person@CONTOSO.COM" },
    { email: "person@department.contoso.com" },
  ]) {
    test(`native initiation preserves provider selection ${JSON.stringify(selection)}`, async () => {
      const org = await seedProvider();
      await seedProvider({
        slug: "unrelated",
        domain: "unrelated.example.com",
      });
      issuer.enqueue(entraClaims());
      const result = await signInThroughIdp(app, {
        ...selection,
        callbackURL,
        errorCallbackURL,
      });
      expect(result.location).toBe(callbackURL);
      const [provider] = await connection.db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.organizationId, org.id));
      const [session] = await connection.db.select().from(sessions);
      expect(session).toMatchObject({
        authenticationProviderId: provider!.id,
        authenticationProviderRevision: provider!.revision,
      });
    });
  }
  test("native SSO initiation evidence cannot be supplied by the browser", async () => {
    await seedProvider();
    const [provider] = await connection.db.select().from(ssoProviders);
    const forged = { [provider!.id]: provider!.revision + 1 };
    const input = {
      providerId: "contoso",
      callbackURL,
      errorCallbackURL,
      serverContext: { answerableSsoProviderRevisions: forged },
      additionalData: {
        answerableSsoProviderRevisions: forged,
        serverContext: { answerableSsoProviderRevisions: forged },
      },
    };
    issuer.enqueue(entraClaims());
    const result = await signInThroughIdp(app, input, async () => {
      const [stored] = await connection.db.select().from(verifications);
      expect(
        JSON.parse(stored!.value).serverContext.answerableSsoProviderRevisions,
      ).toEqual({ [provider!.id]: provider!.revision });
    });
    expect(errorCode(result.location)).toBeNull();
    const [session] = await connection.db.select().from(sessions);
    expect(session).toMatchObject({
      authenticationProviderId: provider!.id,
      authenticationProviderRevision: provider!.revision,
    });
  });
  for (const change of ["delete", "recreate", "unchanged"] as const) {
    test(`restricted native SSO rechecks ${change} configuration after token exchange`, async () => {
      const org = await seedProvider();
      const [provider] = await connection.db.select().from(ssoProviders);
      const input = {
        issuer: provider!.issuer,
        domain: provider!.domain,
        oidc: JSON.parse(provider!.oidcConfig!),
      };
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      beforeTokenResponse = async () => {
        entered.resolve();
        await resume.promise;
      };
      issuer.enqueue(entraClaims());
      const pending = signIn();
      try {
        await entered.promise;
        await inPlatformWrite(connection.db, async (context) => {
          if (change === "delete" || change === "recreate")
            await deleteSsoProvider(context, org.id);
          if (change !== "delete") await putSsoProvider(context, org.id, input);
        });
      } finally {
        beforeTokenResponse = undefined;
        resume.resolve();
      }
      const result = await pending;
      expect(errorCode(result.location)).toBe(
        change === "unchanged" ? null : "SSO_PROVIDER_CHANGED",
      );
      for (const table of [users, accounts, members, sessions])
        expect(await connection.db.select().from(table)).toHaveLength(
          change === "unchanged" ? 1 : 0,
        );
      if (change === "unchanged") {
        const [session] = await connection.db.select().from(sessions);
        expect(session!.authenticationProviderId).toBe(provider!.id);
        expect(session!.authenticationProviderRevision).toBe(
          provider!.revision,
        );
      }
    });
  }
  for (const change of ["update", "delete", "recreate"] as const) {
    test(`restricted callback commits its origin before waiting provider ${change}`, async () => {
      const org = await seedProvider();
      const [provider] = await connection.db.select().from(ssoProviders);
      const input = {
        issuer: provider!.issuer,
        domain: provider!.domain,
        oidc: JSON.parse(provider!.oidcConfig!),
      };
      await connection.db.execute(
        sql`create function test_sso_commit_pause() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(707310036); return new; end $$`,
      );
      await connection.db.execute(
        sql`create trigger zz_sso_commit_pause before insert on sessions for each row execute function test_sso_commit_pause()`,
      );
      const held = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const lock = connection.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(707310036)`);
        held.resolve();
        await resume.promise;
      });
      let pending: ReturnType<typeof signIn> | undefined;
      let writer: Promise<unknown> | undefined;
      let result: Awaited<ReturnType<typeof signIn>> | undefined;
      try {
        await held.promise;
        issuer.enqueue(entraClaims());
        pending = signIn();
        let callbackPid = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = await connection.db.execute(
            sql`select pid from pg_stat_activity where usename = ${roleName} and cardinality(pg_blocking_pids(pid)) > 0`,
          );
          if (active.rows.length) {
            callbackPid = Number(active.rows[0]!.pid);
            break;
          }
          await Bun.sleep(20);
        }
        expect(callbackPid).toBeGreaterThan(0);
        // Identity writes are still inside the paused native transaction.
        expect(await connection.db.select().from(users)).toHaveLength(0);
        const started = Promise.withResolvers<number>();
        writer = inPlatformWrite(connection.db, async (context) => {
          const pid = await context.tx.execute(
            sql`select pg_backend_pid() as pid`,
          );
          started.resolve(Number(pid.rows[0]!.pid));
          if (change === "delete" || change === "recreate")
            await deleteSsoProvider(context, org.id);
          if (change !== "delete")
            await putSsoProvider(
              context,
              org.id,
              change === "update"
                ? {
                    ...input,
                    oidc: { ...input.oidc, clientSecret: "replacement-secret" },
                  }
                : input,
            );
        });
        const writerPid = await started.promise;
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const locks = await connection.db.execute(
            sql`select ${callbackPid} = any(pg_blocking_pids(${writerPid})) as blocked`,
          );
          if (locks.rows[0]!.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(blocked).toBe(true);
      } finally {
        resume.resolve();
        const outcomes = await Promise.allSettled([
          lock,
          pending,
          writer,
        ] as const);
        await connection.db.execute(
          sql`drop trigger zz_sso_commit_pause on sessions`,
        );
        await connection.db.execute(sql`drop function test_sso_commit_pause()`);
        for (const outcome of outcomes)
          expect(outcome.status).toBe("fulfilled");
        result =
          outcomes[1].status === "fulfilled" ? outcomes[1].value : undefined;
      }
      expect(result!.location).toBe(callbackURL);
      const records = await connection.db.select().from(sessions);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        authenticationOrganizationId: org.id,
        authenticationProviderId: provider!.id,
        authenticationProviderRevision: provider!.revision,
      });
      const retained = await connection.db.select().from(ssoProviders);
      const current = retained.filter((row) => row.deletedAt === null);
      if (change !== "update")
        expect(retained.find((row) => row.id === provider!.id)).toMatchObject({
          deletedAt: expect.any(Date),
          oidcConfig: null,
          samlConfig: null,
        });
      if (change === "delete") expect(current).toHaveLength(0);
      else if (change === "recreate")
        expect(current[0]!.id).not.toBe(provider!.id);
      else expect(current[0]!.revision).toBe(provider!.revision + 1);
      expect(await connection.db.select().from(members)).toHaveLength(1);
    });
  }
  test("ordinary native SSO logins preserve provider revision and timestamp", async () => {
    await seedProvider();
    const [before] = await connection.db.select().from(ssoProviders);
    for (let attempt = 0; attempt < 2; attempt++) {
      issuer.enqueue(entraClaims());
      expect(errorCode((await signIn()).location)).toBeNull();
      const [current] = await connection.db.select().from(ssoProviders);
      expect(current!.revision).toBe(before!.revision);
      expect(current!.updatedAt).toEqual(before!.updatedAt);
    }
    const origins = await connection.db.select().from(sessions);
    expect(origins).toHaveLength(2);
    expect(
      origins.map((session) => session.authenticationProviderRevision),
    ).toEqual([before!.revision, before!.revision]);
  });
  test("origin resolution rejects missing providers before identity writes", async () => {
    const auth = createAuth(connection.db, testEnvironment());
    const adapter = authDatabaseAdapter(connection.db)(auth.options);
    const origin = createSsoOriginBoundary();
    const input: Parameters<typeof origin.resolveUser>[0] = {
      protocol: "oidc",
      providerId: "missing",
      providerUser: {
        name: "Person",
        email: "person@contoso.com",
        emailVerified: true,
      },
      accountKey: { issuer: entraIssuer, accountId: "subject" },
      providerClaims: {},
      verifiedIdTokenClaims: entraClaims(),
      providerReference: {
        providerId: "missing",
        source: { type: "persisted", recordId: createId() },
        authenticationConfigurationFingerprint: "unused",
      },
    };
    const resolve = () =>
      adapter.transaction(async (database) =>
        origin.resolveUser(input, { database }),
      );
    await expect(resolve()).rejects.toThrow(
      "Accepted SSO provider is no longer available",
    );
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });
  test("native SSO persists the accepted provider origin on its session", async () => {
    const organization = await seedProvider();
    issuer.enqueue(entraClaims());
    const result = await signIn();
    expect(errorCode(result.location)).toBeNull();
    const [provider] = await connection.db.select().from(ssoProviders);
    const [session] = await connection.db.select().from(sessions);
    expect(session).toMatchObject({
      authenticationOrganizationId: organization.id,
      authenticationProviderId: provider!.id,
      authenticationProviderRevision: provider!.revision,
    });
    const cookie = result.cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const visible = await app.request("/auth/get-session", {
      headers: { Cookie: cookie },
    });
    expect(visible.status).toBe(200);
    expect(await visible.text()).not.toContain('"authentication');
    for (const patch of [
      { id: createId() },
      { userId: createId() },
      { createdAt: new Date(0) },
      { authenticationOrganizationId: createId() },
      { authenticationProviderId: createId() },
      { authenticationProviderRevision: provider!.revision + 1 },
      { authenticationAccountId: createId() },
      { upstreamAuthTime: new Date(0) },
      {
        authenticationOrganizationId: null,
        authenticationProviderId: null,
        authenticationProviderRevision: null,
      },
    ]) {
      await expect(
        connection.db
          .update(sessions)
          .set(patch)
          .where(eq(sessions.id, session!.id))
          .execute(),
      ).rejects.toMatchObject({
        cause: { constraint: "session_authentication_origin_immutable" },
      });
    }
    for (const patch of [
      { authenticationOrganizationId: createId() },
      { authenticationProviderId: createId() },
      { authenticationProviderRevision: provider!.revision + 1 },
    ]) {
      await expect(
        connection.db
          .insert(sessions)
          .values({ ...session!, ...patch, id: createId(), token: createId() })
          .execute(),
      ).rejects.toMatchObject({
        cause: { constraint: "session_authentication_origin_provider" },
      });
    }
    await expect(
      connection.db
        .insert(sessions)
        .values({
          ...session!,
          id: createId(),
          token: createId(),
          authenticationProviderId: null,
        })
        .execute(),
    ).rejects.toMatchObject({
      cause: { constraint: "session_authentication_origin_provider" },
    });
    await connection.db
      .delete(ssoProviders)
      .where(eq(ssoProviders.id, provider!.id));
    expect((await connection.db.select().from(sessions))[0]).toMatchObject({
      authenticationOrganizationId: organization.id,
      authenticationProviderId: provider!.id,
      authenticationProviderRevision: provider!.revision,
    });
  });
  test("a failed origin insert rolls back native SSO user, account and session creation", async () => {
    await seedProvider();
    await connection.db.execute(
      sql`alter table sessions add constraint origin_write_fault check (authentication_provider_id is null)`,
    );
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      issuer.enqueue(entraClaims());
      const failed = await signIn();
      expect(failed.response.status).toBe(500);
      expect(await failed.response.json()).toEqual({
        code: "authentication_unavailable",
        message: "Authentication is temporarily unavailable",
      });
      expect(await connection.db.select().from(sessions)).toHaveLength(0);
      expect(await connection.db.select().from(accounts)).toHaveLength(0);
      expect(await connection.db.select().from(users)).toHaveLength(0);
      expect(diagnostic.mock.calls).toEqual([
        [
          "[id] auth",
          JSON.stringify({ level: "error", event: "provider_diagnostic" }),
        ],
      ]);
    } finally {
      diagnostic.mockRestore();
      await connection.db.execute(
        sql`alter table sessions drop constraint origin_write_fault`,
      );
    }
  });
  test("tenant removal blocks a subsequent valid SSO login without recreating membership", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims());
    expect((await signIn()).location).toBe(callbackURL);
    const [member] = await connection.db.select().from(members);
    await inTenant(
      connection.db,
      member!.organizationId,
      (context) => removeMembership(context, member!.id),
      { requestId: "remove-before-sso" },
    );
    issuer.enqueue(entraClaims());
    const denied = await signIn();
    expect(errorCode(denied.location)).toBe("membership_revoked");
    expect(await connection.db.select().from(members)).toHaveLength(1);
    await inTenant(
      connection.db,
      member!.organizationId,
      (context) => reinstate(context, member!.id),
      { requestId: "reinstate-before-sso" },
    );
    issuer.enqueue(entraClaims());
    expect((await signIn()).location).toBe(callbackURL);
    expect((await connection.db.select().from(members))[0]!.id).toBe(
      member!.id,
    );
  });

  test.each(["federation-audit-test", "x".repeat(513)])(
    "accepts the provider and bounds session/audit user-agent (%#)",
    async (userAgent) => {
      const expectedAgent = userAgent.length <= 512 ? userAgent : null;
      const organization = await seedProvider();
      issuer.enqueue(entraClaims());

      const auditedApp = new Proxy(app, {
        get(target, property, receiver) {
          if (property === "request")
            return (input: string, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              headers.set("x-forwarded-for", "192.0.2.1");
              headers.set("x-real-ip", "198.51.100.7");
              headers.set("cf-connecting-ip", "203.0.113.9");
              headers.set("user-agent", userAgent);
              return target.request(input, { ...init, headers });
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await signInThroughIdp(auditedApp, {
        providerId: "contoso",
        callbackURL,
        errorCallbackURL,
      });
      const [user] = await connection.db.select().from(users);
      const allAccounts = await connection.db.select().from(accounts);
      const [account] = allAccounts;
      const memberships = await connection.db.select().from(members);

      expect(result.location).toBe(callbackURL);
      expect(result.cookies.length).toBeGreaterThan(0);
      expect(user).toMatchObject({
        email: "person@contoso.com",
        emailVerified: true,
        status: "active",
      });
      expect(isUuidV7(user!.id)).toBe(true);
      const successes = await connection.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "auth.signin.succeeded"));
      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        actorId: user!.id,
        ip: "192.0.2.1",
        userAgent: expectedAgent,
        outcome: "success",
      });
      const storedSessions = await connection.db.select().from(sessions);
      expect(storedSessions).toHaveLength(1);
      expect(storedSessions[0]!.ipAddress).toBe("192.0.2.1");
      expect(storedSessions[0]!.userAgent).toBe(expectedAgent);
      // Legacy session metadata was never verified either.
      await connection.db
        .update(sessions)
        .set({ ipAddress: "192.0.2.99", userAgent: "legacy-".repeat(100) });
      const signedOut = await app.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: result.cookies
            .map((value) => value.split(";", 1)[0])
            .join("; "),
          Origin: new URL(callbackURL).origin,
        },
      });
      expect(signedOut.status).toBe(200);
      const signouts = await connection.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "auth.signout"));
      expect(signouts).toHaveLength(1);
      expect(signouts[0]).toMatchObject({
        actorId: user!.id,
        targetId: successes[0]!.targetId,
        ip: null,
        userAgent: null,
      });
      expect(account).toMatchObject({
        userId: user!.id,
        issuer: entraIssuer,
        accountId: "entra-subject",
        directoryId: tenantId,
        directoryUserId: "entra-object",
      });
      expect(isUuidV7(account!.id)).toBe(true);
      expect(allAccounts).toHaveLength(1);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        organizationId: organization.id,
        userId: user!.id,
        role: "member",
      });
    },
  );

  test("rejects a token from a foreign issuer before user resolution", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ iss: "https://foreign.example.com" }));

    const result = await signIn();
    expect(errorCode(result.location)).toBe("invalid_provider");
    expect(
      new URL(result.location!).searchParams.get("error_description"),
    ).toBe("token_not_verified");
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test.each([
    ["directory_mismatch", { tid: "foreign-tenant" }],
    ["guest_account", { idp: "https://guest.example.com" }],
    ["guest_account", { acct: 1 }],
  ] as const)("rejects Entra claim policy: %s", async (code, claims) => {
    await seedProvider();
    issuer.enqueue(entraClaims(claims));

    const result = await signIn();
    expect(errorCode(result.location)).toBe(code);
    const rejected = await connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "auth.signin.rejected"));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: code,
      outcome: "failure",
      schemaVersion: 2,
      data: null,
    });
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test.each([
    ["personal_account", { email_verified: true }],
    ["hosted_domain_mismatch", { hd: "other.example", email_verified: true }],
    ["email_unverified", { hd: "contoso.com", email_verified: false }],
  ] as const)("rejects Google claim policy: %s", async (code, claims) => {
    await seedProvider({ providerIssuer: "https://accounts.google.com" });
    issuer.enqueue({
      sub: "google-subject",
      email: "person@contoso.com",
      name: "Google Person",
      iss: "https://accounts.google.com",
      ...claims,
    });

    const result = await signIn();
    expect(errorCode(result.location)).toBe(code);
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test("rejects an email outside the organization's active domains", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ email: "person@other.example" }));

    expect(errorCode((await signIn()).location)).toBe("domain_not_allowed");
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test("does not borrow another organization's active domain", async () => {
    await seedProvider({ domain: "first.example.com" });
    const [other] = await connection.db
      .insert(organizations)
      .values({ id: createId(), name: "Other", slug: "other" })
      .returning();
    await createOrganizationDomain(connection.db, {
      organizationId: other!.id,
      domain: "contoso.com",
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("domain_not_allowed");
  });

  test("binds an inert import by immutable directory identity", async () => {
    const user = await insertUser("person@contoso.com", "inert");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "import:entra-object",
      providerId: "contoso",
      userId: user.id,
      directoryId: tenantId,
      directoryUserId: "entra-object",
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [updatedUser] = await connection.db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    const boundAccounts = await connection.db.select().from(accounts);
    expect(updatedUser).toMatchObject({
      status: "active",
      emailVerified: true,
    });
    expect(boundAccounts).toHaveLength(1);
    expect(boundAccounts[0]!.accountId).toBe("entra-subject");
  });

  test("releases a disabled holder's recycled email for a new identity", async () => {
    const oldUser = await insertUser("person@contoso.com", "disabled");
    await seedProvider();
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const allUsers = await connection.db.select().from(users);
    const retired = allUsers.find((user) => user.id === oldUser.id)!;
    const replacement = allUsers.find((user) => user.id !== oldUser.id)!;
    expect(retired).toMatchObject({
      email: `${oldUser.id}@retired.invalid`,
      retiredEmail: "person@contoso.com",
      status: "disabled",
    });
    expect(replacement).toMatchObject({
      email: "person@contoso.com",
      status: "active",
    });
  });

  test.each(["active", "inert"] as const)(
    "rejects a recycled email held by an %s user without changing it",
    async (status) => {
      const holder = await insertUser("person@contoso.com", status);
      await seedProvider();
      issuer.enqueue(entraClaims());

      expect(errorCode((await signIn()).location)).toBe("email_conflict");
      expect(await connection.db.select().from(users)).toEqual([holder]);
      expect(await connection.db.select().from(accounts)).toHaveLength(0);
    },
  );

  test("rejects a disabled user already bound to the exact account", async () => {
    const user = await insertUser("person@contoso.com", "disabled");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("user_disabled");
  });

  test("refuses Better Auth's email-linking path", async () => {
    const user = await insertUser("person@contoso.com", "active");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "different-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("email_conflict");
    expect(await connection.db.select().from(accounts)).toHaveLength(1);
  });

  test("uses runtime discovery when endpoint fields are absent", async () => {
    await seedProvider({ providerIssuer: issuer.origin, endpoints: false });
    issuer.enqueue({
      sub: "runtime-subject",
      email: "person@contoso.com",
      email_verified: true,
      name: "Runtime Person",
    });

    expect((await signIn()).location).toBe(callbackURL);
    expect(await connection.db.select().from(users)).toHaveLength(1);
  });

  test("turns a thrown resolver error into an error redirect atomically", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ email: "malformed" }));

    const result = await signIn();
    expect(errorCode(result.location)).toBe("SSO_USER_RESOLUTION_FAILED");
    expect(await connection.db.select().from(users)).toHaveLength(0);
    expect(await connection.db.select().from(accounts)).toHaveLength(0);
  });

  test("fills empty directory columns when the exact account is active", async () => {
    const user = await insertUser("person@contoso.com", "active");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [account] = await connection.db.select().from(accounts);
    expect(account).toMatchObject({
      directoryId: tenantId,
      directoryUserId: "entra-object",
    });
  });

  test("reactivates an inert user already bound to the exact account", async () => {
    const user = await insertUser("person@contoso.com", "inert");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [active] = await connection.db.select().from(users);
    expect(active).toMatchObject({ status: "active", emailVerified: true });
  });

  test("keeps provider selection stable by organization slug", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims());

    const result = await signInThroughIdp(app, {
      organizationSlug: "contoso",
      callbackURL,
      errorCallbackURL,
    });
    expect(result.location).toBe(callbackURL);
    expect(await connection.db.select().from(ssoProviders)).toHaveLength(1);
  });
});
