import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { magicLinkFlow } from "../../__tests__/magic-link-flow.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
import { tenantAuthentication } from "../../auth/tenant-authentication.ts";
import {
  auditEvents,
  organizationDomains,
  sessions,
  ssoProviders,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

const organizationSchema = responseSchema("getOrganization", 200);
const organizationList = responseSchema("listOrganizations", 200);

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4, databaseLockTimeoutMs: 15_000 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(() => fixture?.close());

type Kind = Parameters<AdminFixture["headers"]>[0] | "root";
function admin(
  path: string,
  init: { method?: string; kind?: Kind; key?: string; body?: unknown } = {},
) {
  const headers = fixture.headers(init.kind ?? "platformAdmin");
  if (init.key) headers.set("Idempotency-Key", init.key);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(`/api/admin/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const setAdmission = (
  organizationId: string,
  admission: string,
  init: { kind?: Kind; key?: string } = {},
) =>
  admin(`/organizations/${organizationId}/magic-link`, {
    method: "PATCH",
    body: { admission },
    ...init,
  });

let nextFirm = 0;
const firm = (directory = false) =>
  flow.seedOrganization(`admission-${++nextFirm}`, directory);

const rowOf = async (organizationId: string) =>
  (
    await fixture.db
      .select()
      .from(ssoProviders)
      .where(
        and(
          eq(ssoProviders.organizationId, organizationId),
          eq(ssoProviders.kind, "magic_link"),
        ),
      )
  )[0]!;

const eventsOf = (organizationId: string) =>
  fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.action, "organization.magic_link_admission_changed"),
      ),
    );

describe("to domain", () => {
  test("every active domain proved: the setting moves, audited, and the answer shows it", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    const answer = await setAdmission(organization.id, "domain");
    expect(answer.status).toBe(200);
    expect(organizationSchema.parse(await answer.json())).toMatchObject({
      id: organization.id,
      magicLink: { enabled: true, admission: "domain", listed: 0 },
    });
    expect((await rowOf(organization.id)).admission).toBe("domain");
    const revision = organization.magicLink.revision;
    expect(await eventsOf(organization.id)).toEqual([
      expect.objectContaining({
        targetType: "organization",
        targetId: organization.id,
        outcome: "success",
        operationId: answer.headers.get("Operation-Id"),
        data: {
          before: { admission: "listed", revision },
          after: { admission: "domain", revision },
        },
      }),
    ]);
  });

  test("the same again is a noop with no event", async () => {
    const organization = await firm();
    await flow.openToDomain(organization);
    const events = await eventsOf(organization.id);
    expect(events).toHaveLength(1);
    const again = await setAdmission(organization.id, "domain");
    expect(again.status).toBe(200);
    expect(await eventsOf(organization.id)).toHaveLength(1);
    expect(
      await (await admin(`/organizations/${organization.id}`)).json(),
    ).toMatchObject({ magicLink: { admission: "domain" } });
  });

  test("a domain with no proof refuses, naming which, and changes nothing", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    const unproved = `unproved-${createId()}.example.com`;
    await fixture.db.insert(organizationDomains).values({
      id: createId(),
      organizationId: organization.id,
      domain: unproved,
    });
    const refused = await setAdmission(organization.id, "domain");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "domain_not_verified",
      details: { unverified: [unproved], publicMail: [] },
    });
    expect((await rowOf(organization.id)).admission).toBe("listed");
    expect(await eventsOf(organization.id)).toEqual([]);
  });

  test("a public mail domain refuses, proved or not, named as such", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    await fixture.db.insert(organizationDomains).values({
      id: createId(),
      organizationId: organization.id,
      domain: "proton.me",
      verifiedAt: new Date(),
    });
    const refused = await setAdmission(organization.id, "domain");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "domain_not_verified",
      details: { unverified: [], publicMail: ["proton.me"] },
    });
    await fixture.db
      .delete(organizationDomains)
      .where(eq(organizationDomains.domain, "proton.me"));
  });

  test("no active domain refuses, whatever is disabled or removed", async () => {
    const organization = await firm();
    await fixture.db
      .update(organizationDomains)
      .set({ status: "disabled", verifiedAt: sql`now()` })
      .where(eq(organizationDomains.organizationId, organization.id));
    const refused = await setAdmission(organization.id, "domain");
    expect(refused.status).toBe(409);
    const problem = await refused.json();
    expect(problem).toMatchObject({
      code: "domain_not_verified",
      details: { unverified: [], publicMail: [] },
    });
    expect(problem.detail).toContain("no active domain");
  });

  test("a disabled domain with no proof does not stand in the way", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    await fixture.db.insert(organizationDomains).values({
      id: createId(),
      organizationId: organization.id,
      domain: `off-${createId()}.example.com`,
      status: "disabled",
    });
    expect((await setAdmission(organization.id, "domain")).status).toBe(200);
  });

  test("the platform organisation is refused, whatever its domains", async () => {
    const { organizationId } = fixture.platform;
    const refused = await setAdmission(organizationId, "domain");
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("platform_magic_link");
    expect((await rowOf(organizationId)).admission).toBe("listed");
  });

  test("the setting works with links off, and turning them on later keeps it", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    const base = `/organizations/${organization.id}/magic-link`;
    await admin(`${base}/disable`, { method: "POST" });
    const answer = await setAdmission(organization.id, "domain");
    expect(await answer.json()).toMatchObject({
      magicLink: { enabled: false, admission: "domain" },
    });
    const on = await admin(`${base}/enable`, { method: "POST" });
    expect(await on.json()).toMatchObject({
      magicLink: { enabled: true, admission: "domain" },
    });
  });
});

describe("to listed", () => {
  test("always allowed, even once a domain lost its proof; members stay members", async () => {
    const organization = await firm();
    await flow.openToDomain(organization);
    const person = await flow.listed(organization);
    await fixture.db
      .update(organizationDomains)
      .set({ verifiedAt: null })
      .where(eq(organizationDomains.organizationId, organization.id));
    const answer = await setAdmission(organization.id, "listed");
    expect(await answer.json()).toMatchObject({
      magicLink: { admission: "listed", listed: 1 },
    });
    const member = await admin(
      `/organizations/${organization.id}/members/${person.memberId}`,
    );
    expect(await member.json()).toMatchObject({ effective: true });
  });

  test("the first listed answer on a firm already listed is a noop with no event", async () => {
    const organization = await firm();
    expect((await setAdmission(organization.id, "listed")).status).toBe(200);
    expect(await eventsOf(organization.id)).toEqual([]);
  });
});

describe("changing it ends nobody's session or grant", () => {
  test("on the restricted login: the revision stays, and a live session and grant keep working, both ways", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    await flow.proveDomainOf(organization.id, organization.domain);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    let { refresh_token: refreshToken } = await flow.issueTokens(
      cookie,
      person.memberId,
    );
    const before = await rowOf(organization.id);
    for (const admission of ["domain", "listed", "domain"]) {
      expect((await setAdmission(organization.id, admission)).status).toBe(200);
      const after = await rowOf(organization.id);
      expect(after.admission).toBe(admission as typeof after.admission);
      expect(after.revision).toBe(before.revision);
      const refreshed = await flow.refresh(refreshToken);
      expect(refreshed.status, admission).toBe(200);
      refreshToken = (await refreshed.json()).refresh_token;
      const [session] = await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, person.userId));
      expect(
        await tenantAuthentication(fixture.db, {
          userId: person.userId,
          sessionId: session!.id,
          organizationId: organization.id,
        }),
        admission,
      ).not.toBeNull();
    }
  });

  test("the row keeps the change itself: a guard that only ignored the column would drop it", async () => {
    const organization = await firm();
    const before = await rowOf(organization.id);
    await fixture.db
      .update(ssoProviders)
      .set({ admission: "domain" })
      .where(eq(ssoProviders.id, before.id));
    const after = await rowOf(organization.id);
    expect(after).toMatchObject({
      admission: "domain",
      revision: before.revision,
    });
  });

  test("a change to anything else still moves the revision, with admission beside it or not", async () => {
    const organization = await firm();
    const { id, revision } = await rowOf(organization.id);
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, id));
    expect((await rowOf(organization.id)).revision).toBe(revision + 1);
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: true, admission: "domain" })
      .where(eq(ssoProviders.id, id));
    expect(await rowOf(organization.id)).toMatchObject({
      enabled: true,
      admission: "domain",
      revision: revision + 2,
    });
  });

  test("touching nothing, or only updated_at, writes nothing, and a direct revision is refused", async () => {
    const organization = await firm();
    const before = await rowOf(organization.id);
    await fixture.db.execute(
      sql`update sso_providers set updated_at = now() + interval '1 day' where id = ${before.id}`,
    );
    expect(await rowOf(organization.id)).toEqual(before);
    await fixture.db
      .update(ssoProviders)
      .set({ admission: before.admission })
      .where(eq(ssoProviders.id, before.id));
    expect(await rowOf(organization.id)).toEqual(before);
    await expect(
      Promise.resolve(
        fixture.db.execute(
          sql`update sso_providers set revision = revision + 5, admission = 'domain' where id = ${before.id}`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "configuration_revision_server_controlled" },
    });
  });

  test("a directory row's revision moves on every real change, as it did", async () => {
    const organization = await firm(true);
    const { row } = organization;
    await fixture.db
      .update(ssoProviders)
      .set({ domain: `moved-${createId()}.example.com` })
      .where(eq(ssoProviders.id, row!.id));
    const [after] = await fixture.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, row!.id));
    expect(after!.revision).toBe(row!.revision + 1);
  });

  test("the platform trigger still fires first: turning its row on is refused, with no revision", async () => {
    const before = await rowOf(fixture.platform.organizationId);
    await expect(
      fixture.db
        .update(ssoProviders)
        .set({ enabled: true })
        .where(eq(ssoProviders.id, before.id))
        .then((value) => value),
    ).rejects.toMatchObject({
      cause: { constraint: "sso_providers_platform_magic_link" },
    });
    expect(await rowOf(fixture.platform.organizationId)).toEqual(before);
  });
});

describe("who may set it", () => {
  test("platform:write only; tenants and readers are refused, and nothing moves", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    for (const scopes of [["platform:read"], ["platform:users"]]) {
      const bearer = await fixture.mintMachineToken(scopes);
      expect(
        (await setAdmission(organization.id, "domain", { kind: { bearer } }))
          .status,
        scopes[0],
      ).toBe(403);
    }
    for (const kind of ["platformReader", "tenantAdmin", "noGrant"] as const)
      expect(
        (await setAdmission(organization.id, "domain", { kind })).status,
        kind,
      ).toBeOneOf([403, 404]);
    expect((await rowOf(organization.id)).admission).toBe("listed");
    const bearer = await fixture.mintMachineToken(["platform:write"]);
    expect(
      (await setAdmission(organization.id, "domain", { kind: { bearer } }))
        .status,
    ).toBe(200);
  });

  test("a person whose directory sign-in is stale is refused", async () => {
    const organization = await firm();
    fixture.issuer.enqueue({
      sub: "platformAdmin-subject",
      email: "platformadmin@answerable.example.com",
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 301,
    });
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: fixture.platform.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    const refused = await fixture.app.request(
      `/api/admin/v1/organizations/${organization.id}/magic-link`,
      {
        method: "PATCH",
        headers: {
          Cookie: signedIn.cookies
            .map((value) => value.split(";", 1)[0])
            .join("; "),
          Origin: fixture.trustedOrigin,
          "Content-Type": "application/json",
          "Idempotency-Key": createId(),
        },
        body: JSON.stringify({ admission: "listed" }),
      },
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("reauthentication_required");
  });

  test("an unknown value and a missing organisation answer as they should", async () => {
    const organization = await firm();
    const unknown = await setAdmission(organization.id, "anyone");
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe("validation_failed");
    expect((await setAdmission(createId(), "listed")).status).toBe(404);
  });

  test("the same key replays its receipt with no second event", async () => {
    const organization = await firm();
    await flow.proveDomainOf(organization.id, organization.domain);
    const key = createId();
    const first = await setAdmission(organization.id, "domain", { key });
    const replay = await setAdmission(organization.id, "domain", { key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(
      first.headers.get("Operation-Id"),
    );
    expect(await eventsOf(organization.id)).toHaveLength(1);
  });
});

describe("the organisation's answers", () => {
  test("one organisation shows the effective count, and a list leaves it out", async () => {
    const organization = await firm();
    await flow.listed(organization);
    await flow.listed(organization);
    const ended = await flow.listed(organization);
    await fixture.db.execute(
      sql`update members set valid_until = now() - interval '1 second' where id = ${ended.memberId}`,
    );
    const revoked = await flow.listed(organization);
    await admin(
      `/organizations/${organization.id}/members/${revoked.memberId}`,
      { method: "DELETE" },
    );
    const one = await (await admin(`/organizations/${organization.id}`)).json();
    expect(organizationSchema.parse(one)).toMatchObject({
      magicLink: { enabled: true, admission: "listed", listed: 2 },
    });
    const list = await (
      await admin(`/organizations?q=${organization.slug}`)
    ).json();
    expect(organizationList.parse(list).items[0]!.magicLink).toEqual({
      enabled: true,
      admission: "listed",
    });
  });

  test("every command's answer carries it", async () => {
    const organization = await firm();
    await flow.listed(organization);
    const updated = await admin(`/organizations/${organization.id}`, {
      method: "PATCH",
      body: { name: "Renamed" },
    });
    expect(await updated.json()).toMatchObject({
      magicLink: { listed: 1, admission: "listed" },
    });
    const off = await admin(
      `/organizations/${organization.id}/magic-link/disable`,
      { method: "POST" },
    );
    expect(await off.json()).toMatchObject({
      magicLink: { enabled: false, listed: 1 },
    });
  });
});
