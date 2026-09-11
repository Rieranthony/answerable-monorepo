import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { databaseClock } from "../__tests__/database-clock.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { startOidcIssuer, type OidcIssuer } from "../__tests__/oidc-issuer.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase } from "../db/client.ts";
import * as audit from "../db/queries/audit.ts";
import { assertRuntimeRole, configureRuntimeRole } from "../db/runtime-role.ts";
import {
  accounts,
  auditEvents,
  members,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import * as federation from "../services/federation.ts";
import { putSsoProvider } from "../services/sso-providers.ts";
import * as tenantAuthentication from "./tenant-authentication.ts";

let fixture: AdminFixture;
let runtime: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let role: string;
let clock: ReturnType<typeof databaseClock>;
let extraIssuer: OidcIssuer | undefined;
function setClock(time: Date) {
  setSystemTime(time);
  clock.set(time);
}

beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_verified_sso_${crypto.randomUUID().replaceAll("-", "")}`;
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
    databasePoolMax: 3,
  });
  clock = databaseClock(runtime.pool);
  await assertRuntimeRole(runtime.db);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, fixture.environment),
    environment: fixture.environment,
  });
});
afterEach(async () => {
  setSystemTime();
  extraIssuer?.stop();
  extraIssuer = undefined;
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});

async function login(
  authTime?: number,
  principal: "tenantAdmin" | "platformAdmin" = "tenantAdmin",
) {
  const domain = principal === "platformAdmin" ? "answerable" : "tenant";
  fixture.issuer.enqueue({
    sub: `${principal}-subject`,
    email: `${principal.toLowerCase()}@${domain}.example.com`,
    email_verified: true,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
  });
  const result = await signInThroughIdp(app, {
    providerId: domain,
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  expect(result.location).toBe(`${fixture.trustedOrigin}/callback`);
  return result.cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

test("sensitive human membership commands reject missing and stale upstream time", async () => {
  for (const time of [undefined, Math.floor(Date.now() / 1000) - 301]) {
    const cookie = await login(time);
    const response = await app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`,
      {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: fixture.trustedOrigin,
          "Idempotency-Key": "freshness-proof",
        },
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "reauthentication_required",
    });
  }
});

test("supported reauthentication requests fresh upstream evidence for the current identity", async () => {
  const response = await app.request("/auth/sso/reauthenticate", {
    method: "POST",
    headers: {
      Cookie: fixture.principals.tenantAdmin.cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ callbackURL: `${fixture.trustedOrigin}/callback` }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { url: string };
  expect(result).toHaveProperty("url");
  const { url } = result;
  expect(new URL(url).searchParams.get("max_age")).toBe("0");
  expect(new URL(url).searchParams.get("prompt")).toBe("login");
});

test("supported linking starts only from a freshly verified initiating identity", async () => {
  const cookie = await login(Math.floor(Date.now() / 1000));
  const response = await app.request("/auth/sso/link", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerId: "outsider",
      callbackURL: `${fixture.trustedOrigin}/callback`,
    }),
  });
  expect(response.status).toBe(200);
});

async function begin(
  purpose: "link" | "reauthenticate",
  cookie: string,
  providerId = "outsider",
) {
  const response = await app.request(`/auth/sso/${purpose}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      callbackURL: `${fixture.trustedOrigin}/callback`,
      ...(purpose === "link" ? { providerId } : {}),
    }),
  });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  expect(url).toBeString();
  const jar = new Map(
    cookie
      .split("; ")
      .map((value) => [value.slice(0, value.indexOf("=")), value]),
  );
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0]!;
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return { url, cookie: [...jar.values()].join("; ") };
}

async function complete(
  started: Awaited<ReturnType<typeof begin>>,
  claims: { sub: string; email: string; auth_time?: number },
  callbackApp = app,
  issuer = fixture.issuer,
) {
  issuer.enqueue({ ...claims, email_verified: true });
  const authorization = await fetch(started.url, { redirect: "manual" });
  const callback = new URL(authorization.headers.get("location")!);
  const response = await callbackApp.request(
    `${callback.pathname}${callback.search}`,
    { headers: { Cookie: started.cookie } },
  );
  return {
    response,
    callback,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}

test("native reauthentication preserves identity, records upstream time and permits the original command key", async () => {
  const cookie = await login();
  const url = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
  const command = (cookie: string) =>
    app.request(url, {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: fixture.trustedOrigin,
        "Idempotency-Key": "reauth-retry",
      },
    });
  expect((await command(cookie)).status).toBe(403);
  const started = await begin("reauthenticate", cookie);
  const time = Math.floor(Date.now() / 1000);
  const completed = await complete(started, {
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    auth_time: time,
  });
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const applied = await command(completed.cookie);
  expect(applied.status).toBe(204);
  const replay = await command(completed.cookie);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "member.removed")),
  ).toHaveLength(1);
});

test("native verified linking preserves the global UUID and profile with one atomic binding fact", async () => {
  const issuer = await independentTargetIssuer();
  const userId = fixture.principals.tenantAdmin.userId;
  const [before] = await fixture.db
    .select()
    .from(users)
    .where(eq(users.id, userId));
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  const otherInstance = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, fixture.environment),
    environment: fixture.environment,
  });
  const completed = await complete(
    started,
    {
      sub: "independent-b-subject",
      email: "independent@outsider.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    },
    otherInstance,
    issuer,
  );
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const [bound] = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, "independent-b-subject"));
  expect(bound).toMatchObject({ userId, providerId: "outsider" });
  const [after] = await fixture.db
    .select()
    .from(users)
    .where(eq(users.id, userId));
  expect(after).toMatchObject({ email: before!.email, name: before!.name });
  const [member] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  expect(member?.status).toBe("active");
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "identity.linked"));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorId: userId,
    targetId: bound!.id,
    organizationId: fixture.outsider.organizationId,
    schemaVersion: 1,
  });
  const [targetSession] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.authenticationAccountId, bound!.id));
  expect(targetSession).toMatchObject({
    userId,
    authenticationOrganizationId: fixture.outsider.organizationId,
  });
  const replay = await app.request(
    `${completed.callback.pathname}${completed.callback.search}`,
    { headers: { Cookie: started.cookie } },
  );
  expect(replay.headers.get("location")).not.toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "identity.linked")),
  ).toHaveLength(1);
});

async function independentTargetIssuer(
  beforeTokenResponse?: () => Promise<void>,
) {
  extraIssuer = await startOidcIssuer({ beforeTokenResponse });
  fixture.environment.trustedOrigins.push(extraIssuer.origin);
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, fixture.outsider.organizationId));
  await inPlatformWrite(fixture.db, (context) =>
    putSsoProvider(
      context,
      fixture.outsider.organizationId,
      {
        issuer: extraIssuer!.origin,
        domain: "outsider.example.com",
        oidc: {
          clientId: "independent-b",
          clientSecret: "independent-secret",
          authorizationEndpoint: `${extraIssuer!.origin}/authorize`,
          tokenEndpoint: `${extraIssuer!.origin}/token`,
          jwksEndpoint: `${extraIssuer!.origin}/jwks`,
        },
      },
      { id: provider!.id, revision: provider!.revision },
    ),
  );
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, fixture.environment),
    environment: fixture.environment,
  });
  return extraIssuer;
}

for (const invalid of [
  "missing-time",
  "old-time",
  "different-identity",
] as const) {
  test(`reauthentication rejects ${invalid} without changing the binding or issuing a session`, async () => {
    const started = await begin(
      "reauthenticate",
      fixture.principals.tenantAdmin.cookie,
    );
    const before = await fixture.db.select().from(sessions);
    const completed = await complete(started, {
      sub:
        invalid === "different-identity"
          ? "tenantReader-subject"
          : "tenantAdmin-subject",
      email: "tenantadmin@tenant.example.com",
      ...(invalid === "missing-time"
        ? {}
        : {
            auth_time:
              Math.floor(Date.now() / 1000) - (invalid === "old-time" ? 10 : 0),
          }),
    });
    const location = new URL(completed.response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe(
      invalid === "different-identity"
        ? "authentication_identity_mismatch"
        : "reauthentication_required",
    );
    expect(await fixture.db.select().from(sessions)).toHaveLength(
      before.length,
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "identity.linked")),
    ).toHaveLength(0);
  });
}

test("linking requires fresh initiating evidence and preserves normal login semantics", async () => {
  const cookie = await login();
  const denied = await app.request("/auth/sso/link", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerId: "outsider",
      callbackURL: `${fixture.trustedOrigin}/callback`,
    }),
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    code: "reauthentication_required",
  });
  const start = await app.request("/auth/sign-in/sso", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerId: "outsider",
      callbackURL: `${fixture.trustedOrigin}/callback`,
      serverContext: { answerableIdentityFlow: "forged" },
    }),
  });
  const started = (await start.json()) as { url: string };
  const completed = await complete(
    {
      url: started.url,
      cookie: `${start.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ")}; ${cookie}`,
    },
    { sub: "ordinary-new-subject", email: "ordinary@outsider.example.com" },
  );
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const [ordinary] = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, "ordinary-new-subject"));
  expect(ordinary!.userId).not.toBe(fixture.principals.tenantAdmin.userId);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "identity.linked")),
  ).toHaveLength(0);
});

for (const conflict of [
  "owned",
  "imported",
  "deleted-binding",
  "revoked-member",
  "deleted-member",
  "future-member",
] as const) {
  test(`verified linking rejects ${conflict} without transfer or reinstatement`, async () => {
    const userId = fixture.principals.tenantAdmin.userId;
    let subject = "unowned-target";
    if (conflict === "owned" || conflict === "deleted-binding") {
      subject = "outsider-subject";
      if (conflict === "deleted-binding")
        await fixture.db
          .update(accounts)
          .set({
            deletedAt: new Date(),
            accessToken: null,
            refreshToken: null,
            idToken: null,
          })
          .where(eq(accounts.accountId, subject));
    } else if (conflict === "imported") {
      const imported = createId();
      await fixture.db.insert(users).values({
        id: imported,
        name: "Imported",
        email: "imported@outsider.example.com",
        status: "inert",
      });
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: imported,
        providerId: "outsider",
        issuer: fixture.issuer.origin,
        accountId: "placeholder",
        directoryUserId: subject,
      });
    } else {
      await fixture.db.insert(members).values({
        id: createId(),
        userId,
        organizationId: fixture.outsider.organizationId,
        ...(conflict === "future-member"
          ? { validFrom: new Date(Date.now() + 60_000) }
          : { status: "revoked", revokedAt: new Date() }),
        ...(conflict === "deleted-member" ? { deletedAt: new Date() } : {}),
      });
    }
    const beforeAccounts = await fixture.db.select().from(accounts);
    const beforeSessions = await fixture.db.select().from(sessions);
    if (conflict.endsWith("member")) {
      const response = await app.request("/auth/sso/link", {
        method: "POST",
        headers: {
          Cookie: fixture.principals.tenantAdmin.cookie,
          Origin: fixture.trustedOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          providerId: "outsider",
          callbackURL: `${fixture.trustedOrigin}/callback`,
        }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "membership_revoked",
      });
    } else {
      const started = await begin(
        "link",
        fixture.principals.tenantAdmin.cookie,
      );
      const completed = await complete(started, {
        sub: subject,
        email: "proof@outsider.example.com",
        auth_time: Math.floor(Date.now() / 1000),
      });
      expect(
        new URL(completed.response.headers.get("location")!).searchParams.get(
          "error",
        ),
      ).toBe("identity_conflict");
    }
    expect(await fixture.db.select().from(accounts)).toHaveLength(
      beforeAccounts.length,
    );
    expect(await fixture.db.select().from(sessions)).toHaveLength(
      beforeSessions.length,
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "identity.linked")),
    ).toHaveLength(0);
  });
}

for (const change of [
  "source-provider",
  "target-provider",
  "target-membership",
  "source-user",
  "source-deleted-user",
  "source-member",
  "source-account",
  "session",
  "expiry",
] as const) {
  test(`link callback rejects ${change} changes after initiation`, async () => {
    const started = await begin("link", fixture.principals.tenantAdmin.cookie);
    if (change.endsWith("provider"))
      await fixture.db
        .update(ssoProviders)
        .set({ domain: "changed.example.com" })
        .where(
          eq(
            ssoProviders.organizationId,
            change === "source-provider"
              ? fixture.tenant.organizationId
              : fixture.outsider.organizationId,
          ),
        );
    else if (change === "target-membership")
      await fixture.db.insert(members).values({
        id: createId(),
        userId: fixture.principals.tenantAdmin.userId,
        organizationId: fixture.outsider.organizationId,
        status: "revoked",
        revokedAt: new Date(),
      });
    else if (change === "source-deleted-user")
      await fixture.db
        .update(users)
        .set({
          status: "disabled",
          disabledAt: new Date(),
          deletedAt: new Date(),
        })
        .where(eq(users.id, fixture.principals.tenantAdmin.userId));
    else if (change === "source-member")
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
    else if (change === "source-account")
      await fixture.db
        .update(accounts)
        .set({
          deletedAt: new Date(),
          accessToken: null,
          refreshToken: null,
          idToken: null,
        })
        .where(eq(accounts.accountId, "tenantAdmin-subject"));
    else if (change === "source-user")
      await fixture.db
        .update(users)
        .set({ status: "disabled", disabledAt: new Date() })
        .where(eq(users.id, fixture.principals.tenantAdmin.userId));
    else if (change === "session")
      await fixture.db
        .delete(sessions)
        .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId));
    else
      await fixture.db
        .update(verifications)
        .set({ expiresAt: new Date(0) })
        .where(
          sql`${verifications.identifier} like 'answerable-identity-flow:%'`,
        );
    const beforeSessions = await fixture.db.select().from(sessions);
    const completed = await complete(started, {
      sub: "changed-target",
      email: "proof@outsider.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    });
    expect(completed.response.headers.get("location")).not.toBe(
      `${fixture.trustedOrigin}/callback`,
    );
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, "changed-target")),
    ).toHaveLength(0);
    expect(await fixture.db.select().from(sessions)).toHaveLength(
      beforeSessions.length,
    );
  });
}

test("link callback requires the initiating browser session", async () => {
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  started.cookie = started.cookie
    .split("; ")
    .filter((value) => !value.startsWith("better-auth.session_token="))
    .join("; ");
  const completed = await complete(started, {
    sub: "substituted",
    email: "proof@outsider.example.com",
    auth_time: Math.floor(Date.now() / 1000),
  });
  expect(completed.response.status).toBe(403);
  expect(await completed.response.json()).toMatchObject({
    code: "identity_flow_invalid",
  });
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, "substituted")),
  ).toHaveLength(0);
});

for (const replacement of ["another-user", "another-session"] as const) {
  test(`purpose state rejects ${replacement} even with the original native state cookie`, async () => {
    const alternate =
      replacement === "another-user"
        ? fixture.principals.tenantReader.cookie
        : await login();
    const started = await begin("link", fixture.principals.tenantAdmin.cookie);
    const token = alternate
      .split("; ")
      .find((value) => value.startsWith("better-auth.session_token="))!;
    started.cookie = started.cookie
      .split("; ")
      .map((value) =>
        value.startsWith("better-auth.session_token=") ? token : value,
      )
      .join("; ");
    const completed = await complete(started, {
      sub: "substituted-purpose",
      email: "proof@outsider.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    });
    expect(completed.response.status).toBe(403);
    expect(await completed.response.json()).toMatchObject({
      code: "identity_flow_invalid",
    });
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, "substituted-purpose")),
    ).toHaveLength(0);
  });
}

test("initiating proof expiring upstream prevents the subsequent binding", async () => {
  setClock(new Date());
  const time = Math.floor(Date.now() / 1000) - 240;
  const cookie = await login(time);
  const started = await begin("link", cookie);
  setClock(new Date((time + 301) * 1000));
  const before = await fixture.db.select().from(sessions);
  const completed = await complete(started, {
    sub: "aged-source",
    email: "proof@outsider.example.com",
    auth_time: Math.floor(Date.now() / 1000),
  });
  expect(completed.response.headers.get("location")).not.toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, "aged-source")),
  ).toHaveLength(0);
  expect(await fixture.db.select().from(sessions)).toHaveLength(before.length);
});

for (const failure of ["lost-authority", "database-failure"] as const) {
  test(`native resolution rolls back when callback revalidation reports ${failure}`, async () => {
    const started = await begin("link", fixture.principals.tenantAdmin.cookie);
    const original = tenantAuthentication.tenantAuthentication;
    let checks = 0;
    const validation = spyOn(
      tenantAuthentication,
      "tenantAuthentication",
    ).mockImplementation(async (...args) => {
      const evidence = await original(...args);
      // Allow transaction entry, then fault the later callback revalidation.
      if (++checks === 2) {
        if (failure === "database-failure")
          throw new Error("Authentication query unavailable");
        return null;
      }
      return evidence;
    });
    const before = await fixture.db.select().from(sessions);
    try {
      const completed = await complete(started, {
        sub: "resolution-fault",
        email: "proof@outsider.example.com",
        auth_time: Math.floor(Date.now() / 1000),
      });
      expect(completed.response.headers.get("location")).not.toBe(
        `${fixture.trustedOrigin}/callback`,
      );
      expect(checks).toBe(2);
      expect(
        await fixture.db
          .select()
          .from(accounts)
          .where(eq(accounts.accountId, "resolution-fault")),
      ).toHaveLength(0);
      expect(await fixture.db.select().from(sessions)).toHaveLength(
        before.length,
      );
      expect(
        await fixture.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "identity.linked")),
      ).toHaveLength(0);
    } finally {
      validation.mockRestore();
    }
  });
}

test("native origin validation protects both verified-flow redirect URLs", async () => {
  const auth = createAuth(runtime.db, fixture.environment);
  (await auth.$context).skipOriginCheck = false;
  (await auth.$context).skipCSRFCheck = false;
  const protectedApp = createApp({
    db: runtime.db,
    auth,
    environment: fixture.environment,
  });
  for (const purpose of ["link", "reauthenticate"]) {
    for (const field of ["callbackURL", "errorCallbackURL"]) {
      const response = await protectedApp.request(`/auth/sso/${purpose}`, {
        method: "POST",
        headers: {
          Cookie: fixture.principals.tenantAdmin.cookie,
          Origin: fixture.trustedOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          callbackURL: `${fixture.trustedOrigin}/callback`,
          providerId: "outsider",
          [field]: "https://untrusted.example/steal",
        }),
      });
      expect(response.status).toBe(403);
    }
  }
  expect(
    await fixture.db
      .select()
      .from(verifications)
      .where(
        sql`${verifications.identifier} like 'answerable-identity-flow:%'`,
      ),
  ).toHaveLength(0);
});

test("required linking audit failure rolls back account, membership and native session", async () => {
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  const original = audit.recordAuditEvent;
  const recording = spyOn(audit, "recordAuditEvent").mockImplementation(
    async (tx, event) => {
      if (event.action === "identity.linked")
        throw new Error("injected required linking audit failure");
      return original(tx, event);
    },
  );
  const beforeSessions = await fixture.db.select().from(sessions);
  try {
    const completed = await complete(started, {
      sub: "rollback-target",
      email: "rollback@outsider.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    });
    expect(
      new URL(completed.response.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("SSO_USER_RESOLUTION_FAILED");
  } finally {
    recording.mockRestore();
  }
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, "rollback-target")),
  ).toHaveLength(0);
  expect(
    await fixture.db
      .select()
      .from(members)
      .where(
        and(
          eq(members.userId, fixture.principals.tenantAdmin.userId),
          eq(members.organizationId, fixture.outsider.organizationId),
        ),
      ),
  ).toHaveLength(0);
  expect(await fixture.db.select().from(sessions)).toHaveLength(
    beforeSessions.length,
  );
});

test("concurrent independently verified bindings cannot assign one target identity to two users", async () => {
  const first = await begin("link", fixture.principals.tenantAdmin.cookie);
  const second = await begin("link", fixture.principals.tenantReader.cookie);
  const claims = {
    sub: "contended-target",
    email: "contended@outsider.example.com",
    auth_time: Math.floor(Date.now() / 1000),
  };
  const completed = await Promise.all([
    complete(first, claims),
    complete(second, claims),
  ]);
  expect(
    completed.filter(
      (result) =>
        result.response.headers.get("location") ===
        `${fixture.trustedOrigin}/callback`,
    ),
  ).toHaveLength(1);
  const bound = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, claims.sub));
  expect(bound).toHaveLength(1);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "identity.linked"));
  expect(events).toHaveLength(1);
  expect(events[0]?.actorId).toBe(bound[0]?.userId);
});

test("a stale committed replay requires reauthentication and then recovers the original receipt", async () => {
  setClock(new Date());
  const time = Math.floor(Date.now() / 1000) - 240;
  const cookie = await login(time);
  const url = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
  const command = (value: string) =>
    app.request(url, {
      method: "DELETE",
      headers: {
        Cookie: value,
        Origin: fixture.trustedOrigin,
        "Idempotency-Key": "stale-replay",
      },
    });
  const first = await command(cookie);
  expect(first.status).toBe(204);
  setClock(new Date((time + 301) * 1000));
  const stale = await command(cookie);
  expect(stale.status).toBe(403);
  expect(await stale.json()).toMatchObject({
    code: "reauthentication_required",
  });
  const completed = await complete(await begin("reauthenticate", cookie), {
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    auth_time: Math.floor(Date.now() / 1000),
  });
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const replay = await command(completed.cookie);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Operation-Id")).toBe(
    first.headers.get("Operation-Id"),
  );
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
});

test("reads and display-only edits retain session lifetime while security fields require fresh SSO", async () => {
  const cookie = await login(undefined, "platformAdmin");
  const url = `/api/admin/v1/clients/${fixture.platform.client.clientId}`;
  const read = await app.request(url, { headers: { Cookie: cookie } });
  expect(read.status).toBe(200);
  const patch = (body: object, etag: string, key: string) =>
    app.request(url, {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        Origin: fixture.trustedOrigin,
        "Content-Type": "application/json",
        "If-Match": etag,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const display = await patch(
    { name: "Updated display name" },
    read.headers.get("ETag")!,
    "display-edit",
  );
  expect(display.status).toBe(200);
  const current = await app.request(url, { headers: { Cookie: cookie } });
  const security = await patch(
    { redirectUris: ["https://client.example/callback"] },
    current.headers.get("ETag")!,
    "security-edit",
  );
  expect(security.status).toBe(403);
  expect(await security.json()).toMatchObject({
    code: "reauthentication_required",
  });
});

test("reauthentication can renew the same account after a provider revision change", async () => {
  await fixture.db
    .update(ssoProviders)
    .set({ domain: "alias.example.com" })
    .where(eq(ssoProviders.providerId, "tenant"));
  const completed = await complete(
    await begin("reauthenticate", fixture.principals.tenantAdmin.cookie),
    {
      sub: "tenantAdmin-subject",
      email: "tenantadmin@tenant.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    },
  );
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const read = await app.request(
    `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members`,
    { headers: { Cookie: completed.cookie } },
  );
  expect(read.status).toBe(200);
});

test("a target-row wait cannot let an ageing authentication commit a sensitive command", async () => {
  setClock(new Date());
  const time = Math.floor(Date.now() / 1000) - 240;
  const cookie = await login(time, "platformAdmin");
  const ready = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let blocker = 0;
  const writer = createDatabase(fixture.environment);
  const held = writer.db.transaction(async (tx) => {
    blocker = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    await tx.execute(
      sql`select id from oauth_clients where client_id = ${fixture.platform.client.clientId} for update`,
    );
    ready.resolve();
    await resume.promise;
  });
  await ready.promise;
  const pending = app.request(
    `/api/admin/v1/clients/${fixture.platform.client.clientId}/rotate-secret`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: fixture.trustedOrigin,
        "Idempotency-Key": "aged-target-wait",
      },
    },
  );
  try {
    const deadline = performance.now() + 1200;
    let blocked = false;
    while (performance.now() < deadline) {
      const result = await fixture.db.execute(
        sql`select exists(select 1 from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))) as blocked`,
      );
      if (result.rows[0]!.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    setClock(new Date((time + 301) * 1000));
  } finally {
    resume.resolve();
    await held;
    await writer.close();
  }
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "reauthentication_required",
  });
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "client.secret_rotated")),
  ).toHaveLength(0);
});

test("no database lock spans upstream authentication; a concurrent provider change rejects the callback", async () => {
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const issuer = await independentTargetIssuer(async () => {
    reached.resolve();
    await resume.promise;
  });
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  const pending = complete(
    started,
    {
      sub: "network-wait",
      email: "network@outsider.example.com",
      auth_time: Math.floor(Date.now() / 1000),
    },
    app,
    issuer,
  );
  await reached.promise;
  try {
    // This must finish while the upstream token response is still paused.
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '500ms'`);
      await tx
        .update(ssoProviders)
        .set({ domain: "changed.example.com" })
        .where(
          eq(ssoProviders.organizationId, fixture.outsider.organizationId),
        );
    });
  } finally {
    resume.resolve();
  }
  const completed = await pending;
  expect(completed.response.headers.get("location")).not.toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, "network-wait")),
  ).toHaveLength(0);
});

test("binding-first holds current provider and source authority until the audited native transaction commits", async () => {
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const original = federation.resolveFederatedUser;
  const resolving = spyOn(
    federation,
    "resolveFederatedUser",
  ).mockImplementation(async (...args) => {
    if (args[0].accountKey.accountId === "binding-first") {
      reached.resolve();
      await resume.promise;
    }
    return original(...args);
  });
  const pending = complete(started, {
    sub: "binding-first",
    email: "first@outsider.example.com",
    auth_time: Math.floor(Date.now() / 1000),
  });
  await reached.promise;
  const writer = createDatabase(fixture.environment);
  let pid = 0;
  const changing = writer.db.transaction(async (tx) => {
    pid = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    return tx
      .update(ssoProviders)
      .set({ domain: "changed.example.com" })
      .where(eq(ssoProviders.organizationId, fixture.outsider.organizationId));
  });
  try {
    let blocked = false;
    const deadline = performance.now() + 1200;
    while (performance.now() < deadline) {
      if (pid) {
        const result = await fixture.db.execute(
          sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`,
        );
        if (result.rows[0]!.blocked) {
          blocked = true;
          break;
        }
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
  } finally {
    resume.resolve();
    resolving.mockRestore();
  }
  const completed = await pending;
  await changing;
  await writer.close();
  expect(completed.response.headers.get("location")).toBe(
    `${fixture.trustedOrigin}/callback`,
  );
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, fixture.outsider.organizationId));
  const [account] = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, "binding-first"));
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.authenticationAccountId, account!.id));
  expect(session!.authenticationProviderRevision).toBeLessThan(
    provider!.revision,
  );
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "identity.linked")),
  ).toHaveLength(1);
});

test("a concurrent native state read still allows only one purpose claim and binding", async () => {
  const auth = createAuth(runtime.db, fixture.environment);
  const callbackApp = createApp({
    db: runtime.db,
    auth,
    environment: fixture.environment,
  });
  const started = await begin("link", fixture.principals.tenantAdmin.cookie);
  fixture.issuer.enqueue({
    sub: "single-use",
    email: "single@outsider.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
  });
  const authorization = await fetch(started.url, { redirect: "manual" });
  const callback = new URL(authorization.headers.get("location")!);
  const context = await auth.$context;
  const original = context.adapter.findMany.bind(context.adapter);
  const bothRead = Promise.withResolvers<void>();
  let reads = 0;
  const finding = spyOn(context.adapter, "findMany").mockImplementation(
    async <T>(input: Parameters<typeof original>[0]) => {
      const row = await original<T>(input);
      if (
        reads < 2 &&
        input.model === "verification" &&
        row.length &&
        input.where?.some(
          (condition) =>
            condition.field === "identifier" &&
            condition.value === callback.searchParams.get("state"),
        )
      ) {
        if (++reads === 2) bothRead.resolve();
        await bothRead.promise;
      }
      return row;
    },
  );
  try {
    const results = await Promise.all(
      [1, 2].map(() =>
        callbackApp.request(`${callback.pathname}${callback.search}`, {
          headers: { Cookie: started.cookie },
        }),
      ),
    );
    expect(reads).toBe(2);
    expect(
      results.filter(
        (response) =>
          response.headers.get("location") ===
          `${fixture.trustedOrigin}/callback`,
      ),
    ).toHaveLength(1);
    expect(results.filter((response) => response.status === 403)).toHaveLength(
      1,
    );
  } finally {
    bothRead.resolve();
    finding.mockRestore();
  }
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, "single-use")),
  ).toHaveLength(1);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "identity.linked")),
  ).toHaveLength(1);
});

test("human authority expiry during a target-row wait prevents the sensitive mutation", async () => {
  setClock(new Date());
  const expiry = new Date(Date.now() + 60_000);
  await fixture.db
    .update(members)
    .set({ validUntil: expiry })
    .where(eq(members.id, fixture.principals.platformAdmin.memberId));
  const ready = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let blocker = 0;
  const writer = createDatabase(fixture.environment);
  const held = writer.db.transaction(async (tx) => {
    blocker = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    await tx.execute(
      sql`select id from oauth_clients where client_id = ${fixture.platform.client.clientId} for update`,
    );
    ready.resolve();
    await resume.promise;
  });
  await ready.promise;
  const pending = app.request(
    `/api/admin/v1/clients/${fixture.platform.client.clientId}/rotate-secret`,
    {
      method: "POST",
      headers: {
        Cookie: fixture.principals.platformAdmin.cookie,
        Origin: fixture.trustedOrigin,
        "Idempotency-Key": "expired-authority-wait",
      },
    },
  );
  try {
    let blocked = false;
    const deadline = performance.now() + 700;
    while (performance.now() < deadline) {
      const result = await fixture.db.execute(
        sql`select exists(select 1 from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))) as blocked`,
      );
      if (result.rows[0]!.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    setClock(new Date(expiry.getTime() + 1));
  } finally {
    resume.resolve();
    await held;
    await writer.close();
  }
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "client.secret_rotated")),
  ).toHaveLength(0);
});
