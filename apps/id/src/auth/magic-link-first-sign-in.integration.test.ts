import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { decodeJwt } from "jose";
import { and, eq, inArray } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { cookieOf, magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { codeIn } from "../__tests__/magic-link-requests.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import { createDatabase } from "../db/client.ts";
import {
  accounts,
  auditEventUsers,
  auditEvents,
  members,
  organizationDomains,
  sessions,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import * as publicMail from "../lib/public-mail-domains.ts";
import {
  deleteOrganizationDomain,
  disableDomain,
  endDomainProof,
} from "../services/domains.ts";
import * as memberService from "../services/members.ts";
import {
  disableMagicLink,
  setMagicLinkAdmission,
} from "../services/organizations.ts";
import { disableUser } from "../services/users.ts";
import { magicLinkIssuer } from "./magic-link.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
// Another writer, holding what it holds while a confirmation runs.
const side = createDatabase(testEnvironment({ databasePoolMax: 3 }));
beforeAll(async () => {
  // A pool of one, as confirm's own tests: a first sign-in may not need a second connection.
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(async () => {
  await fixture?.close();
  await side.close();
});

let nextFirm = 0;
/** A firm in domain mode, its one domain proved, through the real commands. */
async function openFirm() {
  const organization = await flow.seedOrganization(
    `first-${++nextFirm}`,
    false,
  );
  const domainId = await flow.openToDomain(organization);
  return { ...organization, domainId };
}

const address = (of: { domain: string }) => `new-${createId()}@${of.domain}`;

const holdersOf = (email: string) =>
  fixture.db.select().from(users).where(eq(users.email, email));
const membersOf = (organizationId: string, userId: string) =>
  fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, userId),
      ),
    );

/** Everything a refused first sign-in must have left as it found it. */
async function expectNothingCreated(email: string) {
  expect(await holdersOf(email)).toEqual([]);
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.issuer, magicLinkIssuer),
          eq(accounts.accountId, email),
        ),
      ),
  ).toEqual([]);
}

async function refusalReasons(requestId: string) {
  return (await flow.refusals("auth.magic_link.refused", requestId)).map(
    ({ reason }) => reason,
  );
}

describe("a first sign-in creates the person", () => {
  test("by link: a user, an active membership, an account and a session, in the one transaction", async () => {
    const firm = await openFirm();
    const email = address(firm);
    expect(await holdersOf(email)).toEqual([]);
    const request = await flow.ask(email);
    expect(request.token).toBeString();
    // Asking creates nothing: only a proved mailbox does.
    expect(await holdersOf(email)).toEqual([]);

    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const [user] = await holdersOf(email);
    expect(user).toMatchObject({
      name: email,
      email,
      emailVerified: true,
      status: "active",
      disabledAt: null,
      retiredEmail: null,
    });
    const [member] = await membersOf(firm.id, user!.id);
    expect(member).toMatchObject({ status: "active", revokedAt: null });
    const [account] = await flow.accountsOf(user!.id);
    expect(account).toMatchObject({
      issuer: magicLinkIssuer,
      providerId: firm.magicLink.providerId,
      accountId: email,
    });
    const [session] = await flow.sessionsOf(user!.id);
    expect(session).toMatchObject({
      authenticationOrganizationId: firm.id,
      authenticationProviderId: firm.magicLink.id,
      authenticationProviderRevision: firm.magicLink.revision,
      authenticationAccountId: account!.id,
      upstreamAuthTime: null,
    });
    expect(cookie).toContain("better-auth.session_token=");
    expect(
      await tenantAuthentication(fixture.db, {
        userId: user!.id,
        sessionId: session!.id,
        organizationId: firm.id,
      }),
    ).not.toBeNull();
  });

  test("by code, from another browser's request page", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    flow.signedIn(await flow.enter(request.code!, request.cookie));
    const [user] = await holdersOf(email);
    expect(await membersOf(firm.id, user!.id)).toHaveLength(1);
  });

  test("the audit is a directory first sign-in's: one sign-in row, naming the person, and no other", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    const [user] = await holdersOf(email);
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, user!.id));
    expect(events.map(({ action }) => action)).toEqual([
      "auth.signin.succeeded",
    ]);
    expect(events[0]).toMatchObject({
      organizationId: firm.id,
      outcome: "success",
      targetType: "session",
      data: expect.objectContaining({
        userId: user!.id,
        authenticationProviderId: firm.magicLink.id,
        upstreamAuthTime: null,
      }),
    });
    const subjects = await fixture.db
      .select()
      .from(auditEventUsers)
      .where(eq(auditEventUsers.eventId, events[0]!.id));
    expect(subjects.map(({ userId }) => userId)).toEqual([user!.id]);
  });

  test("the user is the row a directory's first sign-in writes, but for what it was told", async () => {
    const directoryFirm = await flow.seedOrganization(
      `first-directory-${++nextFirm}`,
    );
    const viaDirectory = await flow.directorySignIn(directoryFirm);
    const [directoryUser] = await fixture.db
      .select()
      .from(users)
      .where(eq(users.id, viaDirectory.userId));
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    const [linkUser] = await holdersOf(email);
    const fields = ({
      emailVerified,
      status,
      disabledAt,
      retiredEmail,
      deletedAt,
      live,
    }: typeof users.$inferSelect) => ({
      emailVerified,
      status,
      disabledAt,
      retiredEmail,
      deletedAt,
      live,
    });
    expect(fields(linkUser!)).toEqual(fields(directoryUser!));
    // Both ids are UUIDv7s from the same generator, which `sub` is.
    expect(linkUser!.id[14]).toBe("7");
    expect(directoryUser!.id[14]).toBe("7");
    const [directoryMember] = await membersOf(
      directoryFirm.id,
      directoryUser!.id,
    );
    const [linkMember] = await membersOf(firm.id, linkUser!.id);
    for (const row of [directoryMember, linkMember])
      expect(row).toMatchObject({
        status: "active",
        revision: 1,
        validFrom: null,
        validUntil: null,
      });
  });

  test("the person gets real tokens, with their id as sub, through organisation-wide access", async () => {
    const firm = await openFirm();
    await flow.allowClient(firm.id);
    const email = address(firm);
    const request = await flow.ask(email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const [user] = await holdersOf(email);
    const [member] = await membersOf(firm.id, user!.id);
    const tokens = await flow.issueTokens(cookie, member!.id);
    const refreshed = await flow.refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const { access_token: accessToken } = (await refreshed.json()) as {
      access_token: string;
    };
    expect(decodeJwt(accessToken)).toMatchObject({
      sub: user!.id,
      authentication_method: "magic_link",
    });
  });

  for (const proof of ["link", "code"] as const)
    test(`by ${proof}, inside an application's authorisation, it resumes to a code with the person it just made`, async () => {
      const firm = await openFirm();
      await flow.allowClient(firm.id);
      const started = await flow.protocol(
        `/oauth2/authorize?${flow.authorizationQuery()}`,
        {},
      );
      const query = new URL(started.headers.get("location")!).search.slice(1);
      const email = address(firm);
      const request = await flow.ask(email, { query });
      const response =
        proof === "link"
          ? await flow.follow(request.token!, request.cookie)
          : await flow.enter(request.code!, request.cookie);
      expect(response.status).toBe(303);
      const next = new URL(response.headers.get("location")!);
      expect(next.pathname).toBe("/authorize");
      const [user] = await holdersOf(email);
      const [member] = await membersOf(firm.id, user!.id);
      const tokens = await flow.finishAuthorization(
        next.search.slice(1),
        cookieOf(response.headers.getSetCookie()),
        member!.id,
      );
      expect(tokens.refresh_token).toBeString();
    });

  test("a user with no membership here gains one, keeping their id; no other audit row", async () => {
    const firm = await openFirm();
    const other = await flow.seedOrganization(
      `first-other-${++nextFirm}`,
      false,
    );
    const person = await flow.listed({ ...other, domain: firm.domain });
    // A member of another firm with no account there: nothing makes them foreign.
    expect(await membersOf(firm.id, person.userId)).toEqual([]);
    const request = await flow.ask(person.email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    expect(await membersOf(firm.id, person.userId)).toHaveLength(1);
    expect(await holdersOf(person.email)).toHaveLength(1);
    const [holder] = await holdersOf(person.email);
    expect(holder!.id).toBe(person.userId);
    const events = await fixture.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorId, person.userId));
    expect(events).toEqual([{ action: "auth.signin.succeeded" }]);
  });

  test("a user with an account of this firm's directory and no membership gains one, linked, on the same user", async () => {
    const firm = await flow.seedOrganization(`first-${++nextFirm}`);
    await flow.openToDomain(firm);
    const elsewhere = await flow.seedOrganization(
      `first-other-${++nextFirm}`,
      false,
    );
    const person = await flow.listed({ id: elsewhere.id, domain: firm.domain });
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: person.userId,
      providerId: firm.row!.providerId,
      issuer: firm.row!.issuer,
      accountId: `subject-${createId()}`,
    });
    // A firm with a live directory routes to it until the choice page, so ask directly.
    const browser = "b".repeat(43);
    await fixture.mail.requests.process({
      address: person.email,
      browser,
      client: "203.0.113.5",
      pendingQuery: null,
    });
    const mail = fixture.mail.transport.sent.findLast(
      (message) => message.to === person.email,
    )!;
    const token = /\/magic-link\?token=([A-Za-z]+)/.exec(mail.text)![1]!;
    flow.signedIn(await flow.follow(token, `answerable-sign-in=${browser}`));
    expect(await membersOf(firm.id, person.userId)).toHaveLength(1);
    expect(await flow.accountsOf(person.userId)).toHaveLength(2);
    const events = await fixture.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorId, person.userId));
    expect(events.map(({ action }) => action).sort()).toEqual([
      "auth.signin.succeeded",
      "identity.linked",
    ]);
  });

  test("a second sign-in finds the person it made, and adds nothing", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const first = await flow.ask(email);
    flow.signedIn(await flow.follow(first.token!, first.cookie));
    const [user] = await holdersOf(email);
    // The limits allow one mail a minute from one client, per address.
    const second = await flow.ask(email, {
      headers: { "cf-connecting-ip": "198.51.100.77" },
    });
    flow.signedIn(await flow.follow(second.token!, second.cookie));
    expect(await holdersOf(email)).toEqual([user!]);
    expect(await membersOf(firm.id, user!.id)).toHaveLength(1);
    expect(await flow.accountsOf(user!.id)).toHaveLength(1);
    expect(await flow.sessionsOf(user!.id)).toHaveLength(2);
  });

  test("a used link is dead: no second person, no second session", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    const replay = await flow.follow(request.token!, request.cookie);
    expect(replay.headers.getSetCookie().join()).not.toContain(
      "better-auth.session_token=",
    );
    const [user] = await holdersOf(email);
    expect(await flow.sessionsOf(user!.id)).toHaveLength(1);
  });
});

describe("what asking sends", () => {
  test("listed: an address no user holds gets no mail, and a domain-mode address does", async () => {
    const listed = await flow.seedOrganization(`first-${++nextFirm}`, false);
    expect((await flow.ask(address(listed))).mail).toBeUndefined();
    const open = await openFirm();
    const mail = (await flow.ask(address(open))).mail!;
    expect(codeIn(mail)).toBeString();
  });

  test("domain mode on a domain with no proof yet: no mail to an unknown address, and a member still gets theirs", async () => {
    const firm = await openFirm();
    const later = `later-${createId()}.example.com`;
    await fixture.db.insert(organizationDomains).values({
      id: createId(),
      organizationId: firm.id,
      domain: later,
    });
    expect((await flow.ask(`new@${later}`)).mail).toBeUndefined();
    const member = await flow.listed({ id: firm.id, domain: later }, "m");
    expect((await flow.ask(member.email)).mail).toBeDefined();
  });

  test("a removed member gets word that access was removed, in domain mode too, and no link", async () => {
    const firm = await openFirm();
    const person = await flow.listed(firm);
    await inTenant(fixture.db, firm.id, (context) =>
      memberService.remove(context, person.memberId),
    );
    const request = await flow.ask(person.email);
    expect(request.mail).toBeDefined();
    expect(request.token).toBeUndefined();
    expect(request.mail!.text).not.toContain("/magic-link?token=");
  });
});

describe("the re-check at confirm is the authority", () => {
  type Change = (
    firm: Awaited<ReturnType<typeof openFirm>>,
    email: string,
  ) => Promise<unknown>;
  const refusals: Record<string, { change: Change; reason: string }> = {
    "the firm switched back to listed": {
      change: (firm) =>
        inPlatformWrite(fixture.db, (context) =>
          setMagicLinkAdmission(context, firm.id, "listed"),
        ),
      reason: "not_admitted",
    },
    "the domain lost its proof": {
      change: (firm) =>
        inPlatformWrite(fixture.db, (context) =>
          endDomainProof(context, firm.id, firm.domainId),
        ),
      reason: "not_admitted",
    },
    "the domain was disabled": {
      change: (firm) =>
        inPlatformWrite(fixture.db, (context) =>
          disableDomain(context, firm.id, firm.domainId),
        ),
      reason: "not_admitted",
    },
    "the domain was removed": {
      change: (firm) =>
        inPlatformWrite(fixture.db, (context) =>
          deleteOrganizationDomain(context, firm.id, firm.domainId),
        ),
      reason: "not_admitted",
    },
    "links were turned off": {
      change: (firm) =>
        inPlatformWrite(fixture.db, (context) =>
          disableMagicLink(context, firm.id),
        ),
      reason: "not_admitted",
    },
  };
  for (const [name, { change, reason }] of Object.entries(refusals))
    test(`a new person is refused when ${name}, and nothing is created`, async () => {
      const firm = await openFirm();
      const email = address(firm);
      const request = await flow.ask(email);
      const [row] = await flow.requestsOf(email);
      await change(firm, email);
      const answer = await flow.follow(request.token!, request.cookie);
      expect(answer.headers.getSetCookie().join()).not.toContain(
        "better-auth.session_token=",
      );
      await expectNothingCreated(email);
      expect(await refusalReasons(row!.id)).toEqual([reason]);
    });

  test("a domain that joined the public list refuses a person it admitted at issue", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    const [row] = await flow.requestsOf(email);
    const listed = spyOn(publicMail, "isPublicMailDomain").mockImplementation(
      (domain) => domain === firm.domain,
    );
    try {
      await flow.follow(request.token!, request.cookie);
    } finally {
      listed.mockRestore();
    }
    await expectNothingCreated(email);
    expect(await refusalReasons(row!.id)).toEqual(["not_admitted"]);
  });

  test("a disabled user is refused, told their access was removed, and gains no membership", async () => {
    const firm = await openFirm();
    const other = await flow.seedOrganization(`first-${++nextFirm}`, false);
    const person = await flow.listed({ ...other, domain: firm.domain });
    const request = await flow.ask(person.email);
    const [row] = await flow.requestsOf(person.email);
    await inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    );
    await flow.follow(request.token!, request.cookie);
    expect(await membersOf(firm.id, person.userId)).toEqual([]);
    expect(await refusalReasons(row!.id)).toEqual(["access_removed"]);
  });

  test("a member removed between issue and confirm stays removed, in domain mode", async () => {
    const firm = await openFirm();
    const person = await flow.listed(firm);
    const request = await flow.ask(person.email);
    const [row] = await flow.requestsOf(person.email);
    await inTenant(fixture.db, firm.id, (context) =>
      memberService.remove(context, person.memberId),
    );
    await flow.follow(request.token!, request.cookie);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    expect(await refusalReasons(row!.id)).toEqual(["access_removed"]);
    const [member] = await membersOf(firm.id, person.userId);
    expect(member!.status).toBe("revoked");
  });

  test("an account of another firm's appearing between issue and confirm refuses", async () => {
    const firm = await openFirm();
    const other = await flow.seedOrganization(`first-${++nextFirm}`);
    const person = await flow.listed({ ...other, domain: firm.domain });
    const request = await flow.ask(person.email);
    const [row] = await flow.requestsOf(person.email);
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: person.userId,
      providerId: other.row!.providerId,
      issuer: other.row!.issuer,
      accountId: `subject-${createId()}`,
    });
    await flow.follow(request.token!, request.cookie);
    expect(await membersOf(firm.id, person.userId)).toEqual([]);
    expect(await refusalReasons(row!.id)).toEqual(["not_admitted"]);
  });

  test("the address's magic-link account on someone else stays account_conflict, and the new user rolls back", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    const [row] = await flow.requestsOf(email);
    // Someone whose address has since changed still holds the old key.
    const elsewhere = await flow.listed(
      { id: firm.id, domain: firm.domain },
      "someone-else",
    );
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: elsewhere.userId,
      providerId: firm.magicLink.providerId,
      issuer: magicLinkIssuer,
      accountId: email,
    });
    await flow.follow(request.token!, request.cookie);
    expect(await holdersOf(email)).toEqual([]);
    expect(await refusalReasons(row!.id)).toEqual(["account_conflict"]);
    expect(await flow.sessionsOf(elsewhere.userId)).toEqual([]);
  });

  test("a holder who appeared after asking and before confirm, with a membership, signs in as themselves", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    // What a directory's first sign-in, or staff importing them, leaves.
    const local = email.split("@")[0]!;
    const person = await flow.listed(firm, local);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    expect(await holdersOf(email)).toHaveLength(1);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
  });

  test("a holder committed while the confirmation waits on the address lock is the person it signs in", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    const client = await side.pool.connect();
    let confirming: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`answerable:magic-link:${email}`],
      );
      confirming = flow.follow(request.token!, request.cookie);
      for (let waiting = false; !waiting;) {
        const { rows } = await side.pool.query(
          "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        waiting = rows[0].count > 0;
        if (!waiting) await Bun.sleep(5);
      }
      const userId = createId();
      await client.query(
        "insert into users (id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')",
        [userId, email, email],
      );
      await client.query(
        "insert into members (id, organization_id, user_id) values ($1, $2, $3)",
        [createId(), firm.id, userId],
      );
      await client.query("commit");
      flow.signedIn(await confirming);
      expect(await flow.sessionsOf(userId)).toHaveLength(1);
    } finally {
      await confirming?.catch(() => {});
      client.release();
    }
  });

  /** Wait until something is blocked on a lock in this database. */
  async function untilBlocked() {
    for (;;) {
      const { rows } = await side.pool.query(
        "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
      );
      if (rows[0].count > 0) return;
      await Bun.sleep(5);
    }
  }

  test("a holder committed after the confirmation looked and before it reads admission has no lock here: it refuses, and they ask again", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    const [row] = await flow.requestsOf(email);
    const client = await side.pool.connect();
    const userId = createId();
    let confirming: Promise<Response> | undefined;
    try {
      // The confirmation has the address and has looked for a holder when it waits on the firm.
      await client.query("begin");
      await client.query(
        "select 1 from organizations where id = $1 for no key update",
        [firm.id],
      );
      confirming = Promise.resolve(flow.follow(request.token!, request.cookie));
      await untilBlocked();
      await client.query(
        "insert into users (id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')",
        [userId, email, email],
      );
      await client.query(
        "insert into members (id, organization_id, user_id) values ($1, $2, $3)",
        [createId(), firm.id, userId],
      );
      await client.query("commit");
      const answer = await confirming;
      expect(answer.headers.getSetCookie().join()).not.toContain(
        "better-auth.session_token=",
      );
      expect(await flow.sessionsOf(userId)).toEqual([]);
      expect(await refusalReasons(row!.id)).toEqual(["provider_changed"]);
    } finally {
      await confirming?.catch(() => {});
      client.release();
    }
  });

  test("a holder retired while the confirmation waits for them frees the address, and refuses: this request was never for a new person", async () => {
    const firm = await openFirm();
    const person = await flow.listed(firm);
    const request = await flow.ask(person.email);
    const [row] = await flow.requestsOf(person.email);
    const client = await side.pool.connect();
    let confirming: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for update", [
        person.userId,
      ]);
      confirming = Promise.resolve(flow.follow(request.token!, request.cookie));
      await untilBlocked();
      await client.query(
        "update users set status = 'disabled', disabled_at = now(), retired_email = email, email = id::text || '@retired.invalid' where id = $1",
        [person.userId],
      );
      await client.query("commit");
      const answer = await confirming;
      expect(answer.headers.getSetCookie().join()).not.toContain(
        "better-auth.session_token=",
      );
      expect(await holdersOf(person.email)).toEqual([]);
      expect(await refusalReasons(row!.id)).toEqual(["provider_changed"]);
    } finally {
      await confirming?.catch(() => {});
      client.release();
    }
  });

  test("a directory's first sign-in racing past the address lock leaves a failure that creates nothing, and the link still works", async () => {
    const firm = await openFirm();
    const email = address(firm);
    const request = await flow.ask(email);
    const client = await side.pool.connect();
    const userId = createId();
    let confirming: Promise<Response> | undefined;
    try {
      // A directory takes no address lock, so its row is only seen at the insert.
      await client.query("begin");
      await client.query(
        "insert into users (id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')",
        [userId, email, email],
      );
      await client.query(
        "insert into members (id, organization_id, user_id) values ($1, $2, $3)",
        [createId(), firm.id, userId],
      );
      confirming = flow.follow(request.token!, request.cookie);
      for (let waiting = false; !waiting;) {
        const { rows } = await side.pool.query(
          "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        waiting = rows[0].count > 0;
        if (!waiting) await Bun.sleep(5);
      }
      await client.query("commit");
      const failed = await confirming;
      expect(failed.headers.getSetCookie().join()).not.toContain(
        "better-auth.session_token=",
      );
      expect(await flow.sessionsOf(userId)).toEqual([]);
      expect(
        (await holdersOf(email)).map(({ id }) => id),
        "the one holder is the directory's",
      ).toEqual([userId]);
      // Nothing was refused, so the request stands, and now finds the holder.
      flow.signedIn(await flow.follow(request.token!, request.cookie));
      expect(await flow.sessionsOf(userId)).toHaveLength(1);
    } finally {
      await confirming?.catch(() => {});
      client.release();
    }
  });
});

describe("what it does not touch", () => {
  test("a directory's first sign-in in domain mode is unchanged, and the magic-link row with it", async () => {
    const firm = await flow.seedOrganization(`first-${++nextFirm}`);
    await flow.openToDomain(firm);
    const person = await flow.directorySignIn(firm);
    const rows = await fixture.db
      .select({ kind: ssoProviders.kind, admission: ssoProviders.admission })
      .from(ssoProviders)
      .where(inArray(ssoProviders.id, [firm.magicLink.id, firm.row!.id]));
    expect(rows.toSorted((a, b) => (a.kind < b.kind ? -1 : 1))).toEqual([
      { kind: "magic_link", admission: "domain" },
      { kind: "oidc", admission: "listed" },
    ]);
    const [session] = await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, person.userId));
    expect(session!.authenticationProviderId).toBe(firm.row!.id);
  });
});
