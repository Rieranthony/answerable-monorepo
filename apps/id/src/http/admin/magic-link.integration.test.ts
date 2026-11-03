import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import {
  liveMagicLinkRow,
  magicLinkFirms,
} from "../../__tests__/magic-link.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import { isUuidV7 } from "../../__tests__/support.ts";
import { tenantAuthentication } from "../../auth/tenant-authentication.ts";
import type { Executor } from "../../db/client.ts";
import { withDatabaseScope } from "../../db/isolation.ts";
import {
  adminOperations,
  auditEvents,
  grantContexts,
  organizations,
  sessions,
  ssoProviders,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

const organizationSchema = responseSchema("getOrganization", 200);

let fixture: AdminFixture;
let firms: ReturnType<typeof magicLinkFirms>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4, databaseLockTimeoutMs: 15_000 },
    { restrictedRole: true },
  );
  firms = magicLinkFirms(fixture);
  await firms.registerClient();
});
afterAll(async () => {
  await fixture?.close();
});

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

const set = (
  organizationId: string,
  action: "enable" | "disable",
  init: { kind?: Kind; key?: string } = {},
) =>
  admin(`/organizations/${organizationId}/magic-link/${action}`, {
    method: "POST",
    ...init,
  });

async function shown(response: Response) {
  expect(response.status).toBe(200);
  return organizationSchema.parse(await response.json());
}

const magicLinkEvents = (organizationId: string) =>
  fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        sql`${auditEvents.action} like 'organization.magic_link_%'`,
      ),
    )
    .orderBy(auditEvents.occurredAt);

const providerRow = async (id: string) =>
  (
    await fixture.db.select().from(ssoProviders).where(eq(ssoProviders.id, id))
  )[0]!;

const magicLinkRowOf = async (organizationId: string) =>
  (await liveMagicLinkRow(fixture.db, organizationId))!;

/** A query builder is only a thenable; `rejects` needs a promise. */
const attempt = (query: PromiseLike<unknown>) => Promise.resolve(query);

const organizationEvidence = [
  "authorizationVersion",
  "deletedAt",
  "disabledAt",
  "id",
  "name",
  "revision",
  "slug",
  "status",
];

test("an organisation made through the admin API holds its row, on", async () => {
  const response = await admin("/organizations", {
    method: "POST",
    body: { slug: "made-by-api", name: "Made by API" },
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.magicLink).toEqual({
    enabled: true,
    admission: "listed",
    listed: 0,
  });

  const row = await magicLinkRowOf(body.id);
  expect(row).toMatchObject({
    organizationId: body.id,
    kind: "magic_link",
    providerId: `magic-link:${body.id}`,
    issuer: "urn:answerable:magic-link",
    domain: "magic-link.invalid",
    oidcConfig: null,
    enabled: true,
    revision: 1,
    deletedAt: null,
  });
  // What the application mints, though a trigger made it.
  expect(isUuidV7(row.id)).toBe(true);
});

test("an organisation the runtime role inserts holds its row, on, with or without a scope", async () => {
  const unscoped = createId();
  await fixture.appDb
    .insert(organizations)
    .values({ id: unscoped, slug: "made-unscoped", name: "Unscoped" });
  expect((await magicLinkRowOf(unscoped)).enabled).toBe(true);

  const scoped = await createOrganization(fixture.appDb, {
    slug: "made-scoped",
    name: "Scoped",
  });
  expect((await magicLinkRowOf(scoped.id)).enabled).toBe(true);
});

test("an organisation inserted already erased gets no row", async () => {
  const id = createId();
  await fixture.db.insert(organizations).values({
    id,
    slug: "born-erased",
    name: "Born erased",
    status: "disabled",
    disabledAt: new Date(),
    deletedAt: new Date(),
  });
  expect(
    await fixture.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, id)),
  ).toEqual([]);
});

test("every organisation read and command answer shows the setting, and organisation evidence does not", async () => {
  const created = await (
    await admin("/organizations", {
      method: "POST",
      body: { slug: "answers", name: "Answers" },
    })
  ).json();
  const { id } = created;
  const path = `/organizations/${id}`;
  const expected = {
    magicLink: { enabled: true, admission: "listed" },
  };
  expect(created).toMatchObject(expected);
  expect(await shown(await admin(path))).toMatchObject(expected);

  const page = await (await admin("/organizations?q=answers")).json();
  expect(page.items.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(page.items[0]).toMatchObject(expected);

  const current = await admin(path);
  const headers = fixture.headers("platformAdmin");
  headers.set("If-Match", current.headers.get("ETag")!);
  headers.set("content-type", "application/json");
  const updated = await fixture.app.request(`/api/admin/v1${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Answers Ltd" }),
  });
  expect(await shown(updated)).toMatchObject(expected);
  const unchanged = await admin(path, {
    method: "PATCH",
    body: { name: "Answers Ltd" },
  });
  expect(await shown(unchanged)).toMatchObject(expected);

  for (const action of ["disable", "disable", "enable", "enable"])
    expect(
      await shown(await admin(`${path}/${action}`, { method: "POST" })),
    ).toMatchObject(expected);

  // The setting is a read of its row, not a constant.
  await set(id, "disable");
  expect(await shown(await admin(path))).toMatchObject({
    magicLink: { enabled: false, admission: "listed", listed: 0 },
  });
  expect(
    await shown(await admin(`${path}/disable`, { method: "POST" })),
  ).toMatchObject({ magicLink: { enabled: false } });

  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, id))
    .orderBy(auditEvents.occurredAt);
  expect(events.map(({ action }) => action)).toEqual([
    "organization.created",
    "organization.updated",
    "organization.disabled",
    "organization.enabled",
    "organization.magic_link_disabled",
    "organization.disabled",
  ]);
  for (const { action, data } of events) {
    if (action === "organization.magic_link_disabled") continue;
    const { before, after } = data as { before: object | null; after: object };
    if (action === "organization.disabled") {
      expect(Object.keys(after).sort()).toEqual([
        "authorizationVersion",
        "status",
      ]);
      continue;
    }
    if (before)
      expect(Object.keys(before).sort()).toEqual(organizationEvidence);
    expect(Object.keys(after).sort()).toEqual(organizationEvidence);
  }
});

test("a tenant's read and the list show each organisation's own setting", async () => {
  const { organizationId } = fixture.tenant;
  await set(organizationId, "disable");
  expect(
    await shown(
      await admin(`/organizations/${organizationId}`, { kind: "tenantReader" }),
    ),
  ).toMatchObject({ id: organizationId, magicLink: { enabled: false } });

  const page = await (
    await admin("/organizations?limit=100", { kind: "platformReader" })
  ).json();
  const settings = new Map<string, boolean>(
    page.items.map((row: { id: string; magicLink: { enabled: boolean } }) => [
      row.id,
      row.magicLink.enabled,
    ]),
  );
  expect(settings.get(organizationId)).toBe(false);
  expect(settings.get(fixture.outsider.organizationId)).toBe(true);
  expect(settings.get(fixture.platform.organizationId)).toBe(false);
  await set(organizationId, "enable");
});

test("turning magic links off ends that row's sessions and grants only, and turning them on revives neither", async () => {
  const firm = await firms.seedOrganization("toggled");
  const other = await firms.seedOrganization("toggled-other");
  await firms.allowClient(firm.id);
  await firms.allowClient(other.id);
  const person = await firms.directorySignIn(firm);
  const colleague = await firms.directorySignIn(other);
  const linked = await firms.magicLinkSession(firm, person);
  const otherLinked = await firms.magicLinkSession(other, colleague);
  const [directorySession] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.authenticationProviderId, firm.row!.id));
  const standing = (session: { id: string }, organizationId: string) => {
    const userId =
      organizationId === firm.id ? person.userId : colleague.userId;
    return tenantAuthentication(fixture.db, {
      userId,
      sessionId: session.id,
      organizationId,
    });
  };
  const tokens = {
    linked: await firms.issueTokens(linked.cookie, person.memberId),
    directory: await firms.issueTokens(person.cookie, person.memberId),
    other: await firms.issueTokens(otherLinked.cookie, colleague.memberId),
  };
  const renew = async (name: keyof typeof tokens, status = 200) => {
    const response = await firms.refresh(tokens[name].refresh_token);
    expect(response.status, name).toBe(status);
    const body = await response.json();
    if (status === 200) tokens[name] = body;
    return body;
  };
  await renew("linked");
  await renew("directory");
  await renew("other");
  expect(await standing(linked.session, firm.id)).not.toBeNull();

  const before = await magicLinkRowOf(firm.id);
  const directoryBefore = await providerRow(firm.row!.id);
  const off = await shown(await set(firm.id, "disable"));
  expect(off).toMatchObject({ id: firm.id, magicLink: { enabled: false } });
  const after = await magicLinkRowOf(firm.id);
  expect(after).toMatchObject({
    id: before.id,
    enabled: false,
    revision: before.revision + 1,
  });

  expect(await standing(linked.session, firm.id)).toBeNull();
  expect((await renew("linked", 400)).error).toBe("invalid_grant");
  // The same person's directory session and grant carry on.
  expect(await standing(directorySession!, firm.id)).not.toBeNull();
  await renew("directory");
  // Another firm's magic-link session and grant carry on.
  expect(await standing(otherLinked.session, other.id)).not.toBeNull();
  await renew("other");
  expect(await magicLinkRowOf(other.id)).toEqual(other.magicLink);
  expect(await providerRow(firm.row!.id)).toEqual(directoryBefore);
  // It ended them by naming an old revision: no row of theirs was written.
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.authenticationSessionId, linked.session.id));
  expect(grant).toMatchObject({
    authenticationProviderRevision: before.revision,
    revokedAt: null,
  });

  const on = await shown(await set(firm.id, "enable"));
  expect(on).toMatchObject({ magicLink: { enabled: true } });
  expect(await magicLinkRowOf(firm.id)).toMatchObject({
    enabled: true,
    revision: before.revision + 2,
  });
  expect(await standing(linked.session, firm.id)).toBeNull();
  expect((await renew("linked", 400)).error).toBe("invalid_grant");
  await renew("directory");
  await renew("other");
  // A new sign-in names the new revision.
  const again = await firms.magicLinkSession(firm, person);
  expect(await standing(again.session, firm.id)).not.toBeNull();

  const events = await magicLinkEvents(firm.id);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    action: "organization.magic_link_disabled",
    actorType: "user",
    actorId: fixture.principals.platformAdmin.userId,
    targetType: "organization",
    targetId: firm.id,
    outcome: "success",
    data: {
      before: { enabled: true, revision: before.revision },
      after: { enabled: false, revision: before.revision + 1 },
    },
  });
  expect(events[1]).toMatchObject({
    action: "organization.magic_link_enabled",
    data: {
      before: { enabled: false, revision: before.revision + 1 },
      after: { enabled: true, revision: before.revision + 2 },
    },
  });
});

test("a command that changes nothing writes no event and keeps the revision; a resent key returns its receipt", async () => {
  const firm = await firms.seedOrganization("no-op", false);
  const { revision } = firm.magicLink;

  const noop = await set(firm.id, "enable", { key: "no-op-enable" });
  expect(noop.headers.get("Operation-Id")).toBeString();
  expect(noop.headers.get("Idempotency-Replayed")).toBe("false");
  expect(await shown(noop)).toMatchObject({ magicLink: { enabled: true } });
  expect(await magicLinkRowOf(firm.id)).toEqual(firm.magicLink);
  expect(await magicLinkEvents(firm.id)).toEqual([]);
  const [receipt] = await fixture.db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, noop.headers.get("Operation-Id")!));
  expect(receipt).toMatchObject({
    name: "enableMagicLink",
    outcome: "noop",
    resultReference: { type: "organization", id: firm.id },
  });

  const first = await set(firm.id, "disable", { key: "no-op-disable" });
  expect(first.status).toBe(200);
  const off = await magicLinkRowOf(firm.id);
  expect(off.revision).toBe(revision + 1);
  const replay = await set(firm.id, "disable", { key: "no-op-disable" });
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(replay.headers.get("Operation-Id")).toBe(
    first.headers.get("Operation-Id"),
  );
  expect(await magicLinkRowOf(firm.id)).toEqual(off);
  expect(await magicLinkEvents(firm.id)).toHaveLength(1);

  const again = await set(firm.id, "disable");
  expect(await shown(again)).toMatchObject({ magicLink: { enabled: false } });
  expect(await magicLinkRowOf(firm.id)).toEqual(off);
  expect(await magicLinkEvents(firm.id)).toHaveLength(1);
});

test("the platform organisation is refused magic links through the API and at the database", async () => {
  const { organizationId } = fixture.platform;
  const row = await magicLinkRowOf(organizationId);
  expect(row.enabled).toBe(false);

  const refused = await set(organizationId, "enable");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: "platform_magic_link",
    title: "The platform organisation cannot use magic links",
  });
  const noop = await set(organizationId, "disable");
  expect(await shown(noop)).toMatchObject({
    id: organizationId,
    magicLink: { enabled: false },
  });
  expect(await magicLinkRowOf(organizationId)).toEqual(row);
  expect(await magicLinkEvents(organizationId)).toEqual([]);

  const refusal = {
    cause: { code: "23514", constraint: "sso_providers_platform_magic_link" },
  };
  const turnOn = eq(ssoProviders.id, row.id);
  await expect(
    attempt(
      fixture.db.update(ssoProviders).set({ enabled: true }).where(turnOn),
    ),
  ).rejects.toMatchObject(refusal);
  await expect(
    inPlatformWrite(fixture.appDb, (context) =>
      attempt(
        context.tx.update(ssoProviders).set({ enabled: true }).where(turnOn),
      ),
    ),
  ).rejects.toMatchObject(refusal);
  // A replacement row is refused too, whatever else the transaction did first.
  await expect(
    fixture.db.transaction(async (tx) => {
      await tx
        .update(ssoProviders)
        .set({ deletedAt: new Date() })
        .where(turnOn);
      await tx.insert(ssoProviders).values({
        id: createId(),
        organizationId,
        kind: "magic_link",
        providerId: `second-magic-link:${organizationId}`,
        issuer: row.issuer,
        domain: row.domain,
      });
    }),
  ).rejects.toMatchObject(refusal);
  expect(await magicLinkRowOf(organizationId)).toEqual(row);

  // The guard asks only about a magic-link row that is on.
  await fixture.db
    .update(ssoProviders)
    .set({ domain: "platform-off.invalid" })
    .where(turnOn);
  expect(await magicLinkRowOf(organizationId)).toMatchObject({
    enabled: false,
    revision: row.revision + 1,
  });
});

test("the switch locks the organisation, then its row, even when it changes nothing", async () => {
  const firm = await firms.seedOrganization("locks", false);
  const organizationRow = eq(organizations.id, firm.id);
  const magicLinkRow = eq(ssoProviders.id, firm.magicLink.id);
  const command = () => set(firm.id, "enable");

  /** The command waits on what `lock` holds, and `meanwhile` runs while it waits. */
  async function waitingOn(
    lock: (tx: Executor) => PromiseLike<unknown>,
    meanwhile: () => Promise<void> = async () => {},
  ) {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = fixture.db.transaction(async (tx) => {
      await lock(tx);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const answer = command();
    let waiting = false;
    for (let tries = 0; tries < 1000 && !waiting; tries++) {
      const { rows } = await fixture.db.execute(
        sql`select 1 from pg_stat_activity where usename = ${fixture.runtimeRole!} and wait_event_type = 'Lock'`,
      );
      waiting = rows.length > 0;
      if (!waiting) await Bun.sleep(10);
    }
    try {
      expect(waiting).toBe(true);
      await meanwhile();
    } finally {
      release.resolve();
    }
    await holder;
    return answer;
  }

  await shown(
    await waitingOn((tx) =>
      tx.select().from(organizations).where(organizationRow).for("update"),
    ),
  );
  await shown(
    await waitingOn(
      (tx) => tx.select().from(ssoProviders).where(magicLinkRow).for("update"),
      // Waiting on the row, it already holds the organisation.
      async () =>
        expect(
          await fixture.db
            .select()
            .from(organizations)
            .where(organizationRow)
            .for("update", { skipLocked: true }),
        ).toEqual([]),
    ),
  );
});

test("a directory row is always on", async () => {
  const firm = await firms.seedOrganization("directory-on");
  const refusal = { cause: { constraint: "sso_providers_enabled_check" } };
  await expect(
    attempt(
      fixture.db
        .update(ssoProviders)
        .set({ enabled: false })
        .where(eq(ssoProviders.id, firm.row!.id)),
    ),
  ).rejects.toMatchObject(refusal);
  const other = await createOrganization(fixture.db, {
    slug: "directory-on-other",
    name: "Other",
  });
  await expect(
    attempt(
      fixture.db.insert(ssoProviders).values({
        id: createId(),
        organizationId: other.id,
        providerId: "directory-off",
        issuer: "https://directory-off.example.com",
        domain: "directory-off.example.com",
        oidcConfig: "{}",
        enabled: false,
      }),
    ),
  ).rejects.toMatchObject(refusal);
});

test("an unknown, an erased and a malformed organisation are refused", async () => {
  const unknown = createId();
  for (const action of ["enable", "disable"] as const) {
    const missing = await set(unknown, action);
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("not_found");
    const malformed = await set("not-a-uuid", action);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe("validation_failed");
  }

  const firm = await firms.seedOrganization("erased-firm");
  const person = await firms.directorySignIn(firm);
  const { session } = await firms.magicLinkSession(firm, person);
  const erased = await admin(`/organizations/${firm.id}?confirm=${firm.id}`, {
    method: "DELETE",
    kind: "root",
  });
  expect(erased.status).toBe(204);
  const rows = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, firm.id));
  expect(rows.map(({ id }) => id).sort()).toEqual(
    [firm.magicLink.id, firm.row!.id].sort(),
  );
  for (const row of rows) expect(row.deletedAt).not.toBeNull();
  expect(
    await tenantAuthentication(fixture.db, {
      userId: person.userId,
      sessionId: session.id,
      organizationId: firm.id,
    }),
  ).toBeNull();
  for (const action of ["enable", "disable"] as const) {
    const answer = await set(firm.id, action);
    expect(answer.status).toBe(404);
    expect((await answer.json()).code).toBe("not_found");
  }
  // Nothing made a new row, and nothing lists the organisation.
  expect(await liveMagicLinkRow(fixture.db, firm.id)).toBeUndefined();
  expect(
    await fixture.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, firm.id)),
  ).toHaveLength(2);
  const page = await (await admin("/organizations?q=erased-firm")).json();
  expect(page.items).toEqual([]);
});

test("the switch needs platform:write, and a tenant's scopes are refused", async () => {
  const { organizationId } = fixture.tenant;
  const before = await magicLinkRowOf(organizationId);
  for (const kind of ["platformReader", "tenantAdmin", "tenantReader"] as const)
    for (const action of ["enable", "disable"] as const) {
      const refused = await set(organizationId, action, { kind });
      expect(refused.status, kind).toBe(403);
      expect((await refused.json()).code).toBe("insufficient_scope");
    }
  const read = await set(organizationId, "disable", {
    kind: { bearer: await fixture.mintMachineToken(["platform:read"]) },
  });
  expect(read.status).toBe(403);
  const users = await set(organizationId, "disable", {
    kind: { bearer: await fixture.mintMachineToken(["platform:users"]) },
  });
  expect(users.status).toBe(403);
  expect(await magicLinkRowOf(organizationId)).toEqual(before);

  // A machine holding platform:write has no freshness to show.
  const bearer = await fixture.mintMachineToken(["platform:write"]);
  const off = await set(organizationId, "disable", { kind: { bearer } });
  expect(await shown(off)).toMatchObject({ magicLink: { enabled: false } });
  const [event] = (await magicLinkEvents(organizationId)).reverse();
  expect(event).toMatchObject({
    actorType: "client",
    actorId: fixture.platform.client.clientId,
  });
  expect(
    (await set(organizationId, "enable", { kind: { bearer } })).status,
  ).toBe(200);
});

test("a person whose directory sign-in is stale is refused, and nothing changes", async () => {
  const { organizationId } = fixture.outsider;
  const before = await magicLinkRowOf(organizationId);
  const events = await magicLinkEvents(organizationId);
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
  const cookie = signedIn.cookies
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  for (const action of ["disable", "enable"]) {
    const refused = await fixture.app.request(
      `/api/admin/v1/organizations/${organizationId}/magic-link/${action}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: fixture.trustedOrigin,
          "Idempotency-Key": createId(),
        },
      },
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("reauthentication_required");
  }
  expect(await magicLinkRowOf(organizationId)).toEqual(before);
  expect(await magicLinkEvents(organizationId)).toEqual(events);
});

test("the switch works with no directory and on a disabled organisation", async () => {
  const firm = await firms.seedOrganization("anytime", false);
  expect(await shown(await set(firm.id, "disable"))).toMatchObject({
    magicLink: { enabled: false },
  });
  await shown(
    await admin(`/organizations/${firm.id}/disable`, { method: "POST" }),
  );
  expect(await shown(await set(firm.id, "enable"))).toMatchObject({
    status: "disabled",
    magicLink: { enabled: true },
  });
  expect(await shown(await set(firm.id, "disable"))).toMatchObject({
    status: "disabled",
    magicLink: { enabled: false },
  });
  expect(await magicLinkEvents(firm.id)).toHaveLength(3);
});

test("the switch leaves the directory alone, and a directory command leaves the switch alone", async () => {
  const firm = await firms.seedOrganization("independent", false);
  const path = `/organizations/${firm.id}/sso-provider`;
  const directory = firms.directoryInput(firm.slug);
  const unmoved = async (expected: { enabled: boolean; revision: number }) =>
    expect(await magicLinkRowOf(firm.id)).toMatchObject(expected);

  // In both states, since a command that rewrote the row would show in either. A directory
  // command still revokes every grant in the organisation, magic-link ones included: it
  // fails closed until directory commands end directory-origin grants only.
  for (const enabled of [false, true]) {
    await set(firm.id, enabled ? "enable" : "disable");
    const row = await magicLinkRowOf(firm.id);
    expect(row.enabled).toBe(enabled);
    const expected = { enabled, revision: row.revision };

    const connected = await admin(path, { method: "PUT", body: directory });
    expect(connected.status).toBe(201);
    await unmoved(expected);
    const changed = await admin(path, {
      method: "PUT",
      body: {
        ...directory,
        oidc: { ...directory.oidc, clientId: `replaced-${enabled}` },
      },
    });
    expect(changed.status).toBe(200);
    await unmoved(expected);
    expect((await admin(path, { method: "DELETE" })).status).toBe(204);
    await unmoved(expected);
  }

  const connected = await admin(path, { method: "PUT", body: directory });
  const { id, revision } = await connected.json();
  await set(firm.id, "disable");
  await set(firm.id, "enable");
  await set(firm.id, "disable");
  expect(await providerRow(id)).toMatchObject({
    revision,
    enabled: true,
    kind: "oidc",
  });
  // With magic links off, the directory still signs people in.
  await firms.directorySignIn(
    { ...firm, row: await providerRow(id) },
    { organizationSlug: firm.slug },
  );
});

test("a live organisation with no row is a fault every answer reports, and hides nothing", async () => {
  const firm = await firms.seedOrganization("no-row", false);
  await fixture.db
    .update(ssoProviders)
    .set({ deletedAt: new Date() })
    .where(eq(ssoProviders.id, firm.magicLink.id));
  try {
    for (const answer of [
      await admin(`/organizations/${firm.id}`),
      await admin("/organizations?q=no-row"),
      await set(firm.id, "enable"),
      await set(firm.id, "disable"),
    ]) {
      expect(answer.status).toBe(500);
      expect((await answer.json()).code).toBe("internal_error");
    }
  } finally {
    await fixture.db.delete(organizations).where(eq(organizations.id, firm.id));
  }
});

test("the runtime role reaches the rows only through its scopes, and cannot run the functions behind them", async () => {
  const firm = await firms.seedOrganization("runtime-reach", false);
  const privileges = await fixture.db.execute<{ name: string; can: boolean }>(
    sql`select name, has_function_privilege(${fixture.runtimeRole!}::name, name || '()', 'execute') as can
      from unnest(array['uuid_v7', 'create_magic_link_provider', 'disable_platform_magic_link']) as name`,
  );
  expect(privileges.rows).toEqual([
    { name: "uuid_v7", can: false },
    { name: "create_magic_link_provider", can: false },
    { name: "disable_platform_magic_link", can: false },
  ]);
  await expect(
    attempt(fixture.appDb.execute(sql`select uuid_v7()`)),
  ).rejects.toMatchObject({ cause: { code: "42501" } });

  // With no scope a write reaches nothing: an update changes no row, an insert is refused.
  const off = fixture.appDb
    .update(ssoProviders)
    .set({ enabled: false })
    .where(eq(ssoProviders.id, firm.magicLink.id))
    .returning({ id: ssoProviders.id });
  expect(await off).toEqual([]);
  await expect(
    attempt(
      fixture.appDb.insert(ssoProviders).values({
        id: createId(),
        organizationId: firm.id,
        kind: "magic_link",
        providerId: "runtime-second",
        issuer: "urn:answerable:magic-link",
        domain: "magic-link.invalid",
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  // Another tenant's scope reaches none of this firm's rows either.
  const foreign = await withDatabaseScope(
    fixture.appDb,
    {
      kind: "tenant",
      access: "write",
      organizationId: fixture.tenant.organizationId,
    },
    (tx) =>
      tx
        .update(ssoProviders)
        .set({ enabled: false })
        .where(eq(ssoProviders.id, firm.magicLink.id))
        .returning({ id: ssoProviders.id }),
  );
  expect(foreign).toEqual([]);
  expect(await magicLinkRowOf(firm.id)).toEqual(firm.magicLink);
});
