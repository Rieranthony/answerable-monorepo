import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { approveAdminCapability } from "../__tests__/capabilities.ts";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import {
  inPlatformRead,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import {
  createSsoProvider,
  lockSsoProvider,
} from "../__tests__/sso-queries.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import { createAuth } from "../auth.ts";
import {
  readSsoEndpoints,
  readSsoIssuer,
} from "../db/queries/sso-providers.ts";
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
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { createCapability } from "../services/capabilities.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

// This release creates no magic-link row: the next one does, and this image is the
// previous image during that rollout and after a tag back. Every test here seeds the
// next release's rows and drives this image's real routes on the runtime role.

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4 },
    { restrictedRole: true },
  );
});
afterAll(async () => {
  await fixture?.close();
});

const callbackURL = "https://console.example.com/callback";

function magicLinkValues(organizationId: string) {
  return {
    id: createId(),
    organizationId,
    kind: "magic_link" as const,
    providerId: `magic-link:${organizationId}`,
    issuer: "urn:answerable:magic-link",
    domain: "magic-link.invalid",
  };
}

async function providerRow(id: string) {
  const [row] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, id));
  return row!;
}

function directoryInput(slug: string) {
  const { origin } = fixture.issuer;
  return {
    issuer: origin,
    domain: `${slug}.example.com`,
    oidc: {
      clientId: `${slug}-client`,
      clientSecret: "secret",
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      jwksEndpoint: `${origin}/jwks`,
    },
  };
}

/** An organisation as the next release leaves it. The magic-link row goes in first, so
 * a scan finds it first, as an index in `(organization_id, kind)` order does. */
async function seedOrganization(slug: string, directory = true) {
  const organization = await createOrganization(fixture.db, {
    slug,
    name: slug,
  });
  const [magicLink] = await fixture.db
    .insert(ssoProviders)
    .values(magicLinkValues(organization.id))
    .returning();
  const domain = `${slug}.example.com`;
  await createOrganizationDomain(fixture.db, {
    organizationId: organization.id,
    domain,
  });
  const row = directory
    ? await createSsoProvider(fixture.db, {
        ...directoryInput(slug),
        organizationId: organization.id,
        providerId: slug,
      })
    : null;
  return { id: organization.id, slug, domain, magicLink: magicLink!, row };
}
type Organization = Awaited<ReturnType<typeof seedOrganization>>;

const cookieOf = (cookies: string[]) =>
  cookies.map((value) => value.split(";", 1)[0]).join("; ");

/** Signs in through the organisation's directory, for real. */
async function directorySignIn(
  organization: Organization,
  selector: Record<string, string> = { providerId: organization.slug },
  name = "person",
) {
  const email = `${name}@${organization.domain}`;
  fixture.issuer.enqueue({
    sub: `${organization.slug}-${name}`,
    email,
    email_verified: true,
    name,
    auth_time: Math.floor(Date.now() / 1000),
  });
  const signedIn = await signInThroughIdp(fixture.app, {
    ...selector,
    callbackURL,
  });
  expect(signedIn.location).toBe(callbackURL);
  const [member] = await fixture.db
    .select({ id: members.id, userId: members.userId })
    .from(members)
    .innerJoin(accounts, eq(accounts.userId, members.userId))
    .where(
      and(
        eq(members.organizationId, organization.id),
        eq(accounts.accountId, `${organization.slug}-${name}`),
      ),
    );
  return {
    email,
    memberId: member!.id,
    userId: member!.userId,
    cookie: cookieOf(signedIn.cookies),
  };
}
type Person = Awaited<ReturnType<typeof directorySignIn>>;

/** The next release's sign-in result, seeded directly: the person's account with the
 * magic-link row, and a session whose origin names that row. */
async function magicLinkSession(
  organization: Organization,
  person: Pick<Person, "email" | "userId">,
  upstreamAuthTime: Date | null = null,
) {
  const { issuer, providerId, id, revision } = await providerRow(
    organization.magicLink.id,
  );
  let [account] = await fixture.db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.userId, person.userId), eq(accounts.issuer, issuer)),
    );
  if (!account)
    [account] = await fixture.db
      .insert(accounts)
      .values({
        id: createId(),
        userId: person.userId,
        issuer,
        providerId,
        accountId: person.email,
      })
      .returning();
  const token = createId();
  const [session] = await fixture.db
    .insert(sessions)
    .values({
      id: createId(),
      userId: person.userId,
      token,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      authenticationOrganizationId: organization.id,
      authenticationProviderId: id,
      authenticationProviderRevision: revision,
      authenticationAccountId: account!.id,
      upstreamAuthTime,
    })
    .returning();
  const signature = await makeSignature(
    token,
    fixture.environment.betterAuthSecret,
  );
  return {
    session: session!,
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

const aSecondAgo = () => new Date(Date.now() - 1000);

function holdAdminAuthority(organization: Organization, person: Person) {
  const { adminResource: resource } = fixture.platform;
  const scopes = ["org:read", "org:users"];
  return Promise.all([
    approveAdminCapability(fixture.db, {
      organizationId: organization.id,
      resource,
      scopes,
    }),
    fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId: organization.id,
      memberId: person.memberId,
      resource,
      scopes,
    }),
  ]);
}

function asPerson(cookie: string) {
  return {
    Cookie: cookie,
    Origin: fixture.trustedOrigin,
    "Idempotency-Key": createId(),
  };
}

/** The admin API's SSO routes, with the preconditions a PUT needs. */
async function ssoRoute(
  organizationId: string,
  method = "GET",
  body?: unknown,
  suffix = "",
) {
  const path = `/api/admin/v1/organizations/${organizationId}/sso-provider${suffix}`;
  const headers = fixture.headers("platformAdmin");
  if (method === "PUT") {
    const current = await fixture.app.request(path, { headers });
    const tag = current.headers.get("ETag");
    headers.set(tag ? "If-Match" : "If-None-Match", tag ?? "*");
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function startSignIn(body: Record<string, string>) {
  return fixture.app.request("/auth/sign-in/sso", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: fixture.trustedOrigin,
    },
    body: JSON.stringify({ ...body, callbackURL }),
  });
}

function providerEvents(organizationId: string) {
  return fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.targetType, "sso_provider"),
      ),
    )
    .orderBy(auditEvents.occurredAt);
}

/** A query builder is only a thenable; `rejects` needs a promise. */
const attempt = (query: PromiseLike<unknown>) => Promise.resolve(query);

test("directory sign-in works twice in a row, by every selector, with a magic-link row first", async () => {
  for (const [index, selector] of [
    (slug: string) => ({ providerId: slug }),
    (slug: string) => ({ organizationSlug: slug }),
    (slug: string) => ({ email: `person@${slug}.example.com` }),
    (slug: string) => ({ domain: `${slug}.example.com` }),
  ].entries()) {
    const organization = await seedOrganization(`signs-in-${index}`);
    const signIn = async () => {
      const { userId } = await directorySignIn(
        organization,
        selector(organization.slug),
      );
      const [session] = await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(sql`${sessions.createdAt} desc`)
        .limit(1);
      expect(session!.authenticationProviderId).toBe(organization.row!.id);
    };
    await signIn();
    // The callback's no-op lock rewrote the directory's tuple: the second sign-in reads
    // a table the first one changed.
    await signIn();
    expect(await providerRow(organization.magicLink.id)).toEqual(
      organization.magicLink,
    );
    expect((await providerRow(organization.row!.id)).revision).toBe(
      organization.row!.revision,
    );
  }
});

test("native SSO never sees a magic-link row through the adapter or its selectors", async () => {
  const both = await seedOrganization("native-both");
  const only = await seedOrganization("native-only", false);
  const { adapter } = await createAuth(fixture.appDb, fixture.environment)
    .$context;
  const model = "ssoProvider";
  const organization = (id: string) => [{ field: "organizationId", value: id }];
  const providerId = only.magicLink.providerId;
  type Row = { id: string };
  const check = async (
    view: Pick<typeof adapter, "findOne" | "findMany" | "count">,
  ) => {
    expect(
      (await view.findOne<Row>({ model, where: organization(both.id) }))!.id,
    ).toBe(both.row!.id);
    expect(
      await view.findOne({ model, where: organization(only.id) }),
    ).toBeNull();
    expect(
      await view.findOne({
        model,
        where: [{ field: "providerId", value: providerId }],
      }),
    ).toBeNull();
    expect(
      await view.findOne({
        model,
        where: [{ field: "domain", value: "magic-link.invalid" }],
      }),
    ).toBeNull();
    const rows = await view.findMany<Row & { issuer: string }>({ model });
    expect(rows.map(({ id }) => id)).toContain(both.row!.id);
    expect(rows.map(({ issuer }) => issuer)).not.toContain(
      only.magicLink.issuer,
    );
    expect(await view.count({ model, where: organization(both.id) })).toBe(1);
    expect(await view.count({ model, where: organization(only.id) })).toBe(0);
  };
  await check(adapter);
  await adapter.transaction(check);

  for (const body of [
    { providerId: both.magicLink.providerId },
    { providerId },
    { domain: "magic-link.invalid" },
    { email: "person@magic-link.invalid" },
    { organizationSlug: only.slug },
  ] as Record<string, string>[]) {
    const started = await startSignIn(body);
    expect(started.status, JSON.stringify(body)).toBe(404);
    expect(started.headers.getSetCookie()).toEqual([]);
  }
});

test("the admin API's SSO routes act on the directory only, and show nothing new", async () => {
  const organization = await seedOrganization("admin-routes");
  const directory = organization.row!;

  const read = await ssoRoute(organization.id);
  expect(read.status).toBe(200);
  const shown = await read.json();
  expect(shown.id).toBe(directory.id);
  expect(shown.providerId).toBe(organization.slug);
  expect(Object.keys(shown).sort()).toEqual(
    [
      "createdAt",
      "domain",
      "id",
      "issuer",
      "oidc",
      "organizationId",
      "providerId",
      "revision",
      "updatedAt",
    ].sort(),
  );

  const probed = await ssoRoute(organization.id, "GET", undefined, "/test");
  expect(probed.status).toBe(200);
  expect((await probed.json()).issuer).toBe(fixture.issuer.origin);

  const changed = await ssoRoute(organization.id, "PUT", {
    ...directoryInput(organization.slug),
    oidc: {
      ...directoryInput(organization.slug).oidc,
      clientId: "replaced-client",
    },
  });
  expect(changed.status).toBe(200);
  const updated = await changed.json();
  expect(updated.id).toBe(directory.id);
  expect(updated.oidc.clientId).toBe("replaced-client");
  expect(updated).not.toHaveProperty("kind");
  const afterPut = await providerRow(directory.id);
  expect(afterPut.revision).toBe(directory.revision + 1);
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );

  // The directory's sign-in follows the replaced configuration.
  await directorySignIn(organization, { organizationSlug: organization.slug });

  const removed = await ssoRoute(organization.id, "DELETE");
  expect(removed.status).toBe(204);
  const afterDelete = await providerRow(directory.id);
  expect(afterDelete.deletedAt).not.toBeNull();
  expect(afterDelete.oidcConfig).toBeNull();
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );
  expect((await ssoRoute(organization.id)).status).toBe(404);
  expect((await ssoRoute(organization.id, "DELETE")).status).toBe(404);

  const recreated = await ssoRoute(
    organization.id,
    "PUT",
    directoryInput(organization.slug),
  );
  expect(recreated.status).toBe(201);
  const created = await recreated.json();
  expect(created.id).not.toBe(directory.id);
  expect(created).not.toHaveProperty("kind");
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );
  // A new provider row is a new identity boundary: this is a person new to it.
  await directorySignIn(
    organization,
    { organizationSlug: organization.slug },
    "second-person",
  );

  const events = await providerEvents(organization.id);
  expect(events.map(({ action }) => action)).toEqual([
    "sso_provider.updated",
    "sso_provider.deleted",
    "sso_provider.created",
  ]);
  const configuration = [
    "domain",
    "id",
    "issuer",
    "oidc",
    "organizationId",
    "providerId",
    "revision",
  ];
  for (const event of events) {
    expect(event.targetId).not.toBe(organization.magicLink.id);
    const { before, after } = event.data as {
      before: object | null;
      after: object;
    };
    if (before) expect(Object.keys(before).sort()).toEqual(configuration);
    expect(Object.keys(after).sort()).toEqual(
      event.action === "sso_provider.deleted"
        ? ["credentialsCleared", "deletedAt", "id", "revision"]
        : configuration,
    );
  }
});

test("the admin API can connect a directory beside a magic-link row", async () => {
  const organization = await seedOrganization("admin-connects", false);
  const connected = await ssoRoute(
    organization.id,
    "PUT",
    directoryInput(organization.slug),
  );
  expect(connected.status).toBe(201);
  expect((await connected.json()).providerId).toBe(organization.slug);
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );
  await directorySignIn(organization, { organizationSlug: organization.slug });
});

test("an organisation with only a magic-link row answers as one with no directory", async () => {
  const organization = await seedOrganization("magic-only", false);
  const bare = await createOrganization(fixture.db, {
    slug: "no-provider",
    name: "No provider",
  });
  await createOrganizationDomain(fixture.db, {
    organizationId: bare.id,
    domain: "no-provider.example.com",
  });
  const compared = [organization.id, bare.id];
  const answers = async (run: (id: string) => Promise<Response>) => {
    const [first, second] = await Promise.all(compared.map(run));
    const body = { ...(await first!.json()), request_id: null };
    const other = { ...(await second!.json()), request_id: null };
    expect(first!.status).toBe(second!.status);
    expect(body).toEqual(other);
    return { status: first!.status, body };
  };

  const read = await answers((id) => ssoRoute(id));
  expect(read.status).toBe(404);
  expect(read.body.code).toBe("not_found");
  const probe = await answers((id) => ssoRoute(id, "GET", undefined, "/test"));
  expect(probe.status).toBe(404);
  expect(probe.body.code).toBe("provider_not_found");
  expect(
    await Promise.all(
      compared.map(async (id) => (await ssoRoute(id, "DELETE")).status),
    ),
  ).toEqual([404, 404]);

  const signIns = await Promise.all(
    [
      { organizationSlug: organization.slug },
      { organizationSlug: "no-provider" },
    ].map(startSignIn),
  );
  expect(signIns.map(({ status }) => status)).toEqual([404, 404]);
  const [magicLinkAnswer, bareAnswer] = await Promise.all(
    signIns.map((response) => response.text()),
  );
  expect(magicLinkAnswer).toBe(bareAnswer!);

  const pages = await Promise.all(
    [organization.domain, "no-provider.example.com"].map(async (domain) => {
      const page = await fixture.app.request("/login", {
        method: "POST",
        headers: {
          origin: fixture.environment.betterAuthUrl,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ email: `person@${domain}` }),
      });
      expect(page.status).toBe(200);
      return (await page.text()).replaceAll(domain, "the-domain");
    }),
  );
  expect(pages[0]).toBe(pages[1]!);

  const diagnosis = await fixture.app.request(
    `/api/admin/v1/organizations/${organization.id}/sign-in-diagnosis?email=${encodeURIComponent(`person@${organization.domain}`)}`,
    { headers: fixture.headers("platformAdmin") },
  );
  expect(diagnosis.status).toBe(200);
  const diagnosed = await diagnosis.json();
  expect(diagnosed.provider).toEqual({
    configured: false,
    kind: null,
    issuer: null,
  });
  expect(diagnosed.verdict.code).toBe("provider_not_found");

  await inTenantRead(
    fixture.db,
    organization.id,
    "memberAccess",
    async (context) => expect(await readSsoIssuer(context)).toBeNull(),
  );
  await inPlatformRead(fixture.db, async (context) =>
    expect(await readSsoEndpoints(context, organization.id)).toBeNull(),
  );
  expect(await lockSsoProvider(fixture.db, organization.id)).toBeNull();
});

test("diagnosis of an organisation with both rows reports its directory", async () => {
  const organization = await seedOrganization("diagnosed-both");
  const diagnosis = await fixture.app.request(
    `/api/admin/v1/organizations/${organization.id}/sign-in-diagnosis?email=${encodeURIComponent(`person@${organization.domain}`)}`,
    { headers: fixture.headers("platformAdmin") },
  );
  const { provider, verdict } = await diagnosis.json();
  expect(provider).toEqual({
    configured: true,
    kind: "oidc",
    issuer: fixture.issuer.origin,
  });
  expect(verdict.code).toBe("authentication_required");
});

test("a magic-link session holds no admin authority; the same person's directory session does", async () => {
  const organization = await seedOrganization("authority");
  const person = await directorySignIn(organization);
  await holdAdminAuthority(organization, person);
  const { cookie, session } = await magicLinkSession(organization, person);

  // The origin is good: the session trigger took it, and the origin check accepts it.
  expect(
    await tenantAuthentication(fixture.db, {
      userId: person.userId,
      sessionId: session.id,
      organizationId: organization.id,
    }),
  ).toMatchObject({
    authenticationProviderId: organization.magicLink.id,
    authenticationProviderKind: "magic_link",
    upstreamAuthTime: null,
  });

  const route = `/api/admin/v1/organizations/${organization.id}`;
  const asDirectory = await fixture.app.request(route, {
    headers: asPerson(person.cookie),
  });
  expect(asDirectory.status).toBe(200);
  const asMagicLink = await fixture.app.request(route, {
    headers: asPerson(cookie),
  });
  expect(asMagicLink.status).toBe(404);
  expect((await asMagicLink.json()).code).toBe("not_found");

  const me = async (value: string) =>
    (
      await (
        await fixture.app.request("/api/admin/v1/me", {
          headers: asPerson(value),
        })
      ).json()
    ).grants.map(
      ({ organizationId }: { organizationId: string }) => organizationId,
    );
  expect(await me(person.cookie)).toEqual([organization.id]);
  expect(await me(cookie)).toEqual([]);

  // The same refusal with a sign-in time on the session: the kind decides, not the time.
  const dated = await magicLinkSession(organization, person, aSecondAgo());
  const datedAnswer = await fixture.app.request(route, {
    headers: asPerson(dated.cookie),
  });
  expect(datedAnswer.status).toBe(404);
  expect(await me(dated.cookie)).toEqual([]);
});

test("the session trigger refuses a magic-link origin that does not match its row", async () => {
  const organization = await seedOrganization("origin-check");
  const person = await directorySignIn(organization);
  const { session } = await magicLinkSession(organization, person);
  await expect(
    attempt(
      fixture.db.insert(sessions).values({
        ...session,
        id: createId(),
        token: createId(),
        authenticationProviderRevision: 2,
      }),
    ),
  ).rejects.toMatchObject({
    cause: { constraint: "session_authentication_origin_provider" },
  });
});

function verifiedSso(
  purpose: "link" | "reauthenticate",
  cookie: string,
  providerId?: string,
) {
  return fixture.app.request(`/auth/sso/${purpose}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: fixture.trustedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      callbackURL,
      ...(providerId ? { providerId } : {}),
    }),
  });
}

const identityFlows = () =>
  fixture.db.$count(
    verifications,
    like(verifications.identifier, "answerable-identity-flow:%"),
  );

test("a magic-link session cannot link or reauthenticate, whatever its sign-in time", async () => {
  const organization = await seedOrganization("no-link");
  const target = await seedOrganization("no-link-target");
  const person = await directorySignIn(organization);
  const flows = await identityFlows();
  for (const time of [null, aSecondAgo()]) {
    const { cookie } = await magicLinkSession(organization, person, time);
    for (const response of [
      await verifiedSso("reauthenticate", cookie),
      await verifiedSso("link", cookie, target.slug),
      await verifiedSso("link", cookie, organization.slug),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("identity_flow_invalid");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  }
  expect(await identityFlows()).toBe(flows);

  // The same person's directory session can do both.
  expect((await verifiedSso("reauthenticate", person.cookie)).status).toBe(200);
  expect((await verifiedSso("link", person.cookie, target.slug)).status).toBe(
    200,
  );
});

test("a link cannot target a magic-link row", async () => {
  const organization = await seedOrganization("link-target");
  const other = await seedOrganization("link-target-other");
  const { cookie } = await directorySignIn(organization);
  const flows = await identityFlows();
  for (const providerId of [
    organization.magicLink.providerId,
    other.magicLink.providerId,
  ]) {
    const response = await verifiedSso("link", cookie, providerId);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("identity_flow_invalid");
  }
  expect(await identityFlows()).toBe(flows);
});

const clientId = "rollout-client";
const clientSecret = "rollout-client-secret";
const resource = "https://service.example/rollout";
const redirect = "https://client.example/callback";
const verifier = "v".repeat(64);

function protocol(
  path: string,
  init: { cookie?: string; json?: object; form?: Record<string, string> },
) {
  return fixture.app.fetch(
    new Request(`${fixture.environment.betterAuthUrl}/auth${path}`, {
      method: init.json || init.form ? "POST" : "GET",
      headers: {
        origin: fixture.trustedOrigin,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.json ? { "content-type": "application/json" } : {}),
        ...(init.form
          ? {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            }
          : {}),
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
      ...(init.form ? { body: new URLSearchParams(init.form) } : {}),
    }),
  );
}

/** The whole user flow from a browser session: authorise, select, consent, exchange. */
async function issueTokens(cookie: string, memberId: string) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: "openid offline_access mail:read",
    resource,
    state: "client-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const started = await protocol(`/oauth2/authorize?${query}`, { cookie });
  const selection = new URL(started.headers.get("location")!);
  expect(selection.pathname).toBe("/authorize");
  const selected = await protocol("/oauth2/continue", {
    cookie,
    json: {
      oauth_query: selection.search.slice(1),
      postLogin: true,
      memberId,
    },
  });
  expect(selected.status).toBe(200);
  const consent = new URL((await selected.json()).url);
  const accepted = await protocol("/oauth2/consent", {
    cookie,
    json: { oauth_query: consent.search.slice(1), accept: true },
  });
  expect(accepted.status).toBe(200);
  const code = new URL((await accepted.json()).url).searchParams.get("code")!;
  const exchanged = await protocol("/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    },
  });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()) as { refresh_token: string };
}

function refresh(token: string) {
  return protocol("/oauth2/token", {
    form: { grant_type: "refresh_token", refresh_token: token, resource },
  });
}

test("a magic-link grant renews by its row's revision, apart from the directory's", async () => {
  const organization = await seedOrganization("renewal");
  const person = await directorySignIn(organization);
  const { session, cookie } = await magicLinkSession(organization, person);
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(clientSecret),
    name: "Rollout client",
    uri: "https://client.example",
    scopes: ["openid", "offline_access", "mail:read"],
    grantTypes: ["authorization_code", "refresh_token"],
    redirectUris: [redirect],
    tokenEndpointAuthMethod: "client_secret_basic",
    skipConsent: false,
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Service",
    allowedScopes: ["openid", "offline_access", "mail:read"],
    accessTokenTtl: 300,
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await inPlatformWrite(fixture.db, async (context) => {
    for (const input of [
      {
        clientId,
        resource: null,
        grantKind: "authorization_code" as const,
        scopes: ["openid", "offline_access"],
      },
      {
        clientId,
        resource,
        grantKind: "authorization_code" as const,
        scopes: ["mail:read"],
      },
      {
        clientId,
        resource,
        grantKind: "refresh_token" as const,
        scopes: ["mail:read"],
      },
    ])
      await createCapability(context, organization.id, input);
  });
  await fixture.db.insert(entitlements).values([
    {
      id: createId(),
      organizationId: organization.id,
      clientId,
      scopes: ["openid", "offline_access"],
    },
    {
      id: createId(),
      organizationId: organization.id,
      clientId,
      resource,
      scopes: ["mail:read"],
    },
  ]);

  const magicLinkTokens = await issueTokens(cookie, person.memberId);
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.authenticationSessionId, session.id));
  expect(grant).toMatchObject({
    authenticationProviderId: organization.magicLink.id,
    authenticationProviderRevision: organization.magicLink.revision,
    upstreamAuthTime: null,
  });
  const directoryTokens = await issueTokens(person.cookie, person.memberId);

  const renewed = await refresh(magicLinkTokens.refresh_token);
  expect(renewed.status).toBe(200);
  const { refresh_token: rotated } = await renewed.json();

  // Any real change to the row moves its revision through the existing guard.
  await fixture.db
    .update(ssoProviders)
    .set({ domain: "changed-magic-link.invalid" })
    .where(eq(ssoProviders.id, organization.magicLink.id));
  expect((await providerRow(organization.magicLink.id)).revision).toBe(
    organization.magicLink.revision + 1,
  );
  const ended = await refresh(rotated);
  expect(ended.status).toBe(400);
  expect((await ended.json()).error).toBe("invalid_grant");
  expect((await refresh(directoryTokens.refresh_token)).status).toBe(200);
});

test("erasing an organisation ends its rows of every kind", async () => {
  const organization = await seedOrganization("erased");
  const person = await directorySignIn(organization);
  const { session } = await magicLinkSession(organization, person);
  const headers = fixture.headers("root");
  const erased = await fixture.app.request(
    `/api/admin/v1/organizations/${organization.id}?confirm=${organization.id}`,
    { method: "DELETE", headers },
  );
  expect(erased.status).toBe(204);
  for (const id of [organization.row!.id, organization.magicLink.id]) {
    const row = await providerRow(id);
    expect(row.deletedAt).not.toBeNull();
    expect(row.oidcConfig).toBeNull();
  }
  expect(
    await tenantAuthentication(fixture.db, {
      userId: person.userId,
      sessionId: session.id,
      organizationId: organization.id,
    }),
  ).toBeNull();
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "organization.erased"),
        eq(auditEvents.targetId, organization.id),
      ),
    );
  const { softDeletedSsoProviders } = (
    event!.data as {
      effects: { softDeletedSsoProviders: { id: string }[] };
    }
  ).effects;
  expect(softDeletedSsoProviders.map(({ id }) => id).sort()).toEqual(
    [organization.row!.id, organization.magicLink.id].sort(),
  );
  for (const provider of softDeletedSsoProviders)
    expect(provider).not.toHaveProperty("kind");
});

test("a row's kind cannot change, in either direction, on any connection", async () => {
  const organization = await seedOrganization("immutable-kind");
  const change = (id: string, kind: "oidc" | "magic_link") =>
    fixture.db
      .update(ssoProviders)
      .set({ kind })
      .where(eq(ssoProviders.id, id));
  const refusal = {
    cause: { code: "23514", constraint: "sso_providers_kind_immutable" },
  };
  await expect(
    attempt(change(organization.magicLink.id, "oidc")),
  ).rejects.toMatchObject(refusal);
  await expect(
    attempt(change(organization.row!.id, "magic_link")),
  ).rejects.toMatchObject(refusal);
  await expect(
    inPlatformWrite(fixture.appDb, (context) =>
      attempt(
        context.tx
          .update(ssoProviders)
          .set({ kind: "oidc" })
          .where(eq(ssoProviders.id, organization.magicLink.id)),
      ),
    ),
  ).rejects.toMatchObject(refusal);
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );
  expect(await providerRow(organization.row!.id)).toEqual(organization.row!);
  // An update that names the same kind is no change.
  await change(organization.magicLink.id, "magic_link");
  expect(await providerRow(organization.magicLink.id)).toEqual(
    organization.magicLink,
  );
});

test("an organisation holds one live row of each kind", async () => {
  const organization = await seedOrganization("one-of-each");
  const duplicate = {
    cause: {
      code: "23505",
      constraint: "sso_providers_organization_kind_unique",
    },
  };
  await expect(
    attempt(
      fixture.db.insert(ssoProviders).values({
        ...magicLinkValues(organization.id),
        providerId: "second-magic-link",
      }),
    ),
  ).rejects.toMatchObject(duplicate);
  await expect(
    attempt(
      fixture.db.insert(ssoProviders).values({
        id: createId(),
        organizationId: organization.id,
        providerId: "second-directory",
        issuer: "https://second.example.com",
        domain: "second.example.com",
        oidcConfig: "{}",
      }),
    ),
  ).rejects.toMatchObject(duplicate);

  // Only a live row counts: a removed one leaves room for the next.
  await fixture.db
    .update(ssoProviders)
    .set({ deletedAt: new Date() })
    .where(eq(ssoProviders.id, organization.magicLink.id));
  await fixture.db.insert(ssoProviders).values({
    ...magicLinkValues(organization.id),
    providerId: "next-magic-link",
  });
});

test("a live directory has its configuration and a magic-link row never has one", async () => {
  const organization = await seedOrganization("config-check");
  const other = await createOrganization(fixture.db, {
    slug: "config-check-other",
    name: "Other",
  });
  const refused = { cause: { constraint: "sso_providers_kind_config_check" } };
  const refusedBy = (constraint: string) => ({ cause: { constraint } });
  for (const [query, refusal] of [
    [
      fixture.db
        .insert(ssoProviders)
        .values({ ...magicLinkValues(other.id), oidcConfig: "{}" }),
      refused,
    ],
    [
      fixture.db
        .update(ssoProviders)
        .set({ oidcConfig: "{}" })
        .where(eq(ssoProviders.id, organization.magicLink.id)),
      refused,
    ],
    [
      fixture.db.insert(ssoProviders).values({
        id: createId(),
        organizationId: other.id,
        providerId: "no-config",
        issuer: "https://no-config.example.com",
        domain: "no-config.example.com",
      }),
      refused,
    ],
    [
      fixture.db
        .update(ssoProviders)
        .set({ oidcConfig: null })
        .where(eq(ssoProviders.id, organization.row!.id)),
      refused,
    ],
    [
      fixture.db
        .update(ssoProviders)
        .set({ deletedAt: new Date() })
        .where(eq(ssoProviders.id, organization.row!.id)),
      refusedBy("sso_providers_deleted_check"),
    ],
    [
      fixture.db
        .insert(ssoProviders)
        .values({ ...magicLinkValues(other.id), kind: "saml" as "oidc" }),
      refusedBy("sso_providers_kind_check"),
    ],
  ] as const)
    await expect(attempt(query)).rejects.toMatchObject(refusal);

  // A removed directory holds none, as it always has.
  await fixture.db
    .update(ssoProviders)
    .set({ deletedAt: new Date(), oidcConfig: null })
    .where(eq(ssoProviders.id, organization.row!.id));
});

test("the revision guard treats a magic-link row like any other", async () => {
  const organization = await seedOrganization("revision-guard");
  const { id, revision } = organization.magicLink;
  await fixture.db
    .update(ssoProviders)
    .set({ providerId: organization.magicLink.providerId })
    .where(eq(ssoProviders.id, id));
  expect(await providerRow(id)).toEqual(organization.magicLink);
  await fixture.db
    .update(ssoProviders)
    .set({ updatedAt: new Date(Date.now() + 1000) })
    .where(eq(ssoProviders.id, id));
  expect((await providerRow(id)).revision).toBe(revision);
  await fixture.db
    .update(ssoProviders)
    .set({ issuer: "urn:answerable:changed" })
    .where(eq(ssoProviders.id, id));
  expect((await providerRow(id)).revision).toBe(revision + 1);
});
