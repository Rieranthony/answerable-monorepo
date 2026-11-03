import { runWithEndpointContext } from "@better-auth/core/context";
import type { DBAdapter } from "better-auth";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import { createIdVerifier } from "@answerable/auth";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { cookieOf, magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import {
  accounts,
  auditEventUsers,
  auditEvents,
  grantContexts,
  magicLinkRequests,
  members,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  disableMagicLink,
  enableMagicLink,
} from "../services/organizations.ts";
import * as memberService from "../services/members.ts";
import {
  magicLinkGrantLifetimeSeconds,
  magicLinkIdentifier,
  magicLinkIssuer,
  magicLinkSessionLifetimeSeconds,
} from "./magic-link.ts";
import { maxPendingQueryLength } from "../http/pages/login-routing.ts";
import { authenticationTransaction } from "./database-adapter.ts";
import { createSsoOriginBoundary } from "./sso-origin.ts";
import { grantLifetimeSeconds } from "./user-oauth-flow.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  // A pool of one: nothing a sign-in does may need a second connection, audit rows included.
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(() => fixture?.close());

let nextFirm = 0;
const firm = (directory = false) =>
  flow.seedOrganization(`confirm-${++nextFirm}`, directory);

/** A listed person with a live request in this browser. */
async function asked(directory = false) {
  const organization = await firm(directory);
  const person = await flow.listed(organization);
  if (directory) {
    // A firm with a directory routes to it until W7, so the request is made directly.
    const browser = "b".repeat(43);
    await fixture.mail.requests.process({
      address: person.email,
      browser,
      client: "203.0.113.5",
      pendingQuery: null,
    });
    const [row] = await flow.requestsOf(person.email);
    return {
      organization,
      ...person,
      row: row!,
      cookie: `answerable-sign-in=${browser}`,
      ...codes(person.email),
    };
  }
  const request = await flow.ask(person.email);
  const [row] = await flow.requestsOf(person.email);
  return {
    organization,
    ...person,
    row: row!,
    cookie: request.cookie,
    token: request.token!,
    code: request.code!,
  };
}

function codes(email: string) {
  const mail = fixture.mail.transport.sent.findLast((m) => m.to === email)!;
  return {
    token: /\/magic-link\?token=([A-Za-z]+)/.exec(mail.text)![1]!,
    code: /^(\d{8})$/m.exec(mail.text)![1]!,
  };
}

async function refusalsOf(requestId: string) {
  return flow.refusals("auth.magic_link.refused", requestId);
}

async function setOff(organizationId: string) {
  await inPlatformWrite(fixture.db, (context) =>
    disableMagicLink(context, organizationId),
  );
}
async function setOn(organizationId: string) {
  await inPlatformWrite(fixture.db, (context) =>
    enableMagicLink(context, organizationId),
  );
}

describe("the path in", () => {
  test("it is not on the allowlist: /auth/magic-link/confirm answers 404 on every method", async () => {
    const person = await asked();
    for (const method of ["GET", "POST", "PUT"]) {
      const response = await fixture.app.request("/auth/magic-link/confirm", {
        method,
        headers: {
          origin: fixture.environment.betterAuthUrl,
          cookie: person.cookie,
          "content-type": "application/json",
        },
        ...(method === "GET"
          ? {}
          : {
              body: JSON.stringify({
                identifier: person.row.tokenIdentifier,
                browser: "x",
                proof: "link",
              }),
            }),
      });
      expect(response.status, method).toBe(404);
    }
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });

  test("Better Auth's own router would refuse it too: it is server only", async () => {
    const person = await asked();
    const response = await fixture.auth.handler(
      new Request(
        `${fixture.environment.betterAuthUrl}/auth/magic-link/confirm`,
        {
          method: "POST",
          headers: {
            origin: fixture.environment.betterAuthUrl,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            identifier: person.row.tokenIdentifier,
            browser: "b".repeat(43),
            proof: "link",
          }),
        },
      ),
    );
    expect(response.status).toBe(404);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });

  test("no OpenAPI document names it", async () => {
    for (const path of ["/openapi.json", "/api/admin/openapi.json"]) {
      const served = await fixture.app.request(path);
      expect(served.status).toBe(200);
      expect(await served.text()).not.toContain("magic-link/confirm");
    }
  });
});

describe("what signs in", () => {
  const confirm = (
    identifier: string,
    browser: string,
    proof: "link" | "code" = "link",
  ) =>
    fixture.auth.api.confirmMagicLink({
      body: { identifier, browser, proof },
      headers: new Headers(),
      request: new Request(
        `${fixture.environment.betterAuthUrl}/auth/magic-link/confirm`,
      ),
      asResponse: true,
    });

  test("the comparison with the browser is in the confirmation itself: a token alone never signs in", async () => {
    const person = await asked();
    const response = await confirm(
      magicLinkIdentifier(person.token),
      "another-browser",
    );
    expect(await response.json()).toEqual({ refused: "invalid" });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    expect(await flow.tokenRows(person.row.tokenIdentifier!)).toHaveLength(1);
    // Nobody's real cookie, so no audit row, and the request lives on.
    expect(await refusalsOf(person.row.id)).toEqual([]);
    expect((await flow.requestsOf(person.email))[0]!.expiresAt.getTime()).toBe(
      person.row.expiresAt.getTime(),
    );
    flow.signedIn(await flow.follow(person.token, person.cookie));
  });

  test("an identifier no row holds is refused with nothing written", async () => {
    const response = await confirm(magicLinkIdentifier("unknown"), "browser");
    expect(await response.json()).toEqual({ refused: "invalid" });
  });

  test("only a sent link: sending and failed rows, and an expired one, are ended", async () => {
    for (const change of [
      { sendStatus: "sending" as const },
      { expiresAt: new Date(Date.now() - 1_000) },
    ]) {
      const person = await asked();
      await fixture.db
        .update(magicLinkRequests)
        .set(change)
        .where(eq(magicLinkRequests.id, person.row.id));
      const browser = decodeURIComponent(person.cookie.split("=")[1]!);
      const answer = await confirm(person.row.tokenIdentifier!, browser);
      expect(await answer.json()).toEqual({ refused: "invalid" });
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
      const [event] = await refusalsOf(person.row.id);
      expect(event!.reason).toBe("ended");
    }
  });

  test("the pages treat a row not yet sent, or failed, as no link at all", async () => {
    for (const change of [
      { sendStatus: "sending" as const },
      {
        sendStatus: "failed" as const,
        postmarkErrorCode: 500,
        postmarkHttpStatus: 500,
      },
    ]) {
      const person = await asked();
      await fixture.db
        .update(magicLinkRequests)
        .set(change)
        .where(eq(magicLinkRequests.id, person.row.id));
      const page = await flow.open(person.token, person.cookie);
      expect(await page.text()).not.toContain(person.email);
      await flow.follow(person.token, person.cookie);
      // Refused before the confirmation, so it is not a refused sign-in.
      expect(await refusalsOf(person.row.id)).toEqual([]);
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
    }
  });

  test("a link at three attempts is ended; a code at three is its own third", async () => {
    const link = await asked();
    const code = await asked();
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 3 })
      .where(eq(magicLinkRequests.id, link.row.id));
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 3 })
      .where(eq(magicLinkRequests.id, code.row.id));
    expect(
      await (
        await confirm(
          link.row.tokenIdentifier!,
          link.cookie.split("=")[1]!,
          "link",
        )
      ).json(),
    ).toEqual({ refused: "invalid" });
    expect(
      await (
        await confirm(
          code.row.tokenIdentifier!,
          code.cookie.split("=")[1]!,
          "code",
        )
      ).json(),
    ).toEqual({ url: "/login" });
    const [row] = await flow.requestsOf(code.email);
    expect(row!.attempts).toBe(2);
  });

  test("at three attempts the row's link and code are both dead", async () => {
    const person = await asked();
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 3 })
      .where(eq(magicLinkRequests.id, person.row.id));
    const link = await flow.follow(person.token, person.cookie);
    expect(link.status).toBe(200);
    const code = await flow.enter(person.code, person.cookie);
    expect(code.status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });

  test("a token consumed by other means refuses, and the rollback leaves its audit row", async () => {
    const person = await asked();
    await fixture.db
      .delete(verifications)
      .where(eq(verifications.identifier, person.row.tokenIdentifier!));
    const response = await flow.follow(person.token, person.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    // The account the transaction wrote before it found that out went with it.
    expect(await flow.accountsOf(person.userId)).toEqual([]);
    const [event] = await refusalsOf(person.row.id);
    expect(event!.reason).toBe("token_consumed");
  });

  test("a failure inside the confirmation is not a refusal: it is logged, audits nothing and consumes nothing", async () => {
    const person = await asked();
    const lines: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    await fixture.db.execute(
      sql.raw(
        `alter table sessions add constraint fails_for_test check (user_id <> '${person.userId}') not valid`,
      ),
    );
    let response: Response;
    try {
      response = await flow.follow(person.token, person.cookie);
    } finally {
      console.error = error;
      await fixture.db.execute(
        sql`alter table sessions drop constraint fails_for_test`,
      );
    }
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).toContain("This link can");
    const failures = lines.filter((line) =>
      line.includes("page_auth_call_failed"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"path":"/magic-link"');
    expect(failures[0]).toContain('"code":"23514"');
    expect(failures.join()).not.toContain(person.email);
    expect(await refusalsOf(person.row.id)).toEqual([]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    expect(await flow.accountsOf(person.userId)).toEqual([]);
    expect(await flow.tokenRows(person.row.tokenIdentifier!)).toHaveLength(1);
    // Nothing was spent: it works once the fault has gone.
    flow.signedIn(await flow.follow(person.token, person.cookie));
  });

  test("a row with a token whose record does not match is not used", async () => {
    const person = await asked();
    await fixture.db
      .update(magicLinkRequests)
      .set({
        purpose: "access_removed",
        tokenIdentifier: null,
        browserHash: null,
        codeHmac: null,
      })
      .where(eq(magicLinkRequests.id, person.row.id));
    expect((await flow.follow(person.token, person.cookie)).status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });
});

describe("a sign-in", () => {
  test("names the firm's row and its revision, with no directory time, and writes its audit row", async () => {
    const person = await asked();
    const before = await flow.tokenRows(person.row.tokenIdentifier!);
    expect(before).toHaveLength(1);
    flow.signedIn(
      await flow.follow(person.token, person.cookie, {
        "x-request-id": "sign-in-request",
      }),
    );
    const [session] = await flow.sessionsOf(person.userId);
    const [account] = await flow.accountsOf(person.userId);
    expect(account).toMatchObject({
      issuer: magicLinkIssuer,
      providerId: `magic-link:${person.organization.id}`,
      accountId: person.email,
      userId: person.userId,
      deletedAt: null,
    });
    expect(session).toMatchObject({
      authenticationOrganizationId: person.organization.id,
      authenticationProviderId: person.organization.magicLink.id,
      authenticationProviderRevision: person.organization.magicLink.revision,
      authenticationAccountId: account!.id,
      upstreamAuthTime: null,
    });
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
      actorId: person.userId,
      organizationId: person.organization.id,
      requestId: "sign-in-request",
    });
    expect(event!.data).toMatchObject({ upstreamAuthTime: null });
    // The authority checks read it as a session of this firm.
    const authority = await tenantAuthentication(fixture.db, {
      userId: person.userId,
      sessionId: session!.id,
      organizationId: person.organization.id,
    });
    expect(authority?.authenticationProviderKind).toBe("magic_link");
    expect(authority?.memberId).toBe(person.memberId);
  });

  test("using the link ends both: the token is gone, the code is dead, and a second session needs a new mail", async () => {
    const person = await asked();
    flow.signedIn(await flow.follow(person.token, person.cookie));
    expect(await flow.tokenRows(person.row.tokenIdentifier!)).toEqual([]);
    const code = await flow.enter(person.code, person.cookie);
    expect(code.status).toBe(200);
    expect(code.headers.getSetCookie()).toEqual([]);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    const [row] = await flow.requestsOf(person.email);
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    // A row at its end counts no attempts.
    expect(row!.attempts).toBe(0);
  });

  test("using the code ends both, and a right code is not counted as a wrong one", async () => {
    const person = await asked();
    flow.signedIn(await flow.enter(person.code, person.cookie));
    expect(await flow.tokenRows(person.row.tokenIdentifier!)).toEqual([]);
    const link = await flow.follow(person.token, person.cookie);
    expect(link.status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    const [row] = await flow.requestsOf(person.email);
    expect(row!.attempts).toBe(0);
  });

  test("a second sign-in reuses the account, and says nothing of a link", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    flow.signedIn(await flow.follow(first.token!, first.cookie));
    await fixture.db
      .update(magicLinkRequests)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(magicLinkRequests.email, person.email));
    const second = await flow.ask(person.email);
    flow.signedIn(await flow.follow(second.token!, second.cookie));
    expect(await flow.accountsOf(person.userId)).toHaveLength(1);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(2);
    const linked = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "identity.linked"),
          eq(auditEvents.actorId, person.userId),
        ),
      );
    expect(linked).toEqual([]);
  });

  test("a person with an account of this firm's directory keeps one user, and the link is audited", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    const browser = "e".repeat(43);
    await fixture.mail.requests.process({
      address: person.email,
      browser,
      client: "203.0.113.6",
      pendingQuery: null,
    });
    const { token } = codes(person.email);
    const session = flow.signedIn(
      await flow.follow(token, `answerable-sign-in=${browser}`),
    );
    const held = await flow.accountsOf(person.userId);
    expect(held.map((row) => row.issuer).sort()).toEqual(
      [fixture.issuer.origin, magicLinkIssuer].sort(),
    );
    const [linked] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "identity.linked"),
          eq(auditEvents.actorId, person.userId),
        ),
      );
    expect(linked).toMatchObject({
      targetType: "account",
      organizationId: organization.id,
      outcome: "success",
    });
    expect(linked!.data).toMatchObject({
      authenticationProviderId: organization.magicLink.id,
      upstreamAuthTime: null,
    });
    // Each session names the method that made it.
    expect((await flow.sessionsOf(person.userId)).length).toBe(2);
    const page = await fixture.app.request("/security", {
      headers: { cookie: session },
    });
    expect(await page.text()).not.toContain("Verify sign-in");
  });

  test("a soft-deleted account of another kind is no other account, so nothing is linked", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: person.userId,
      issuer: "https://gone.example.com",
      providerId: `gone-${createId()}`,
      accountId: "gone-subject",
      deletedAt: new Date(),
    });
    const request = await flow.ask(person.email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    const linked = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "identity.linked"),
          eq(auditEvents.actorId, person.userId),
        ),
      );
    expect(linked).toEqual([]);
  });

  test("a removed directory's account never blocks a link", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    await fixture.db
      .update(ssoProviders)
      .set({ deletedAt: new Date(), oidcConfig: null })
      .where(eq(ssoProviders.id, organization.row!.id));
    const request = await flow.ask(person.email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
  });

  test("an account of this address on someone else stops it, with one refusal", async () => {
    const person = await asked();
    const someone = createId();
    await fixture.db.insert(users).values({
      id: someone,
      name: "Someone",
      email: `someone-${someone}@elsewhere.example.com`,
      status: "active",
    });
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: someone,
      issuer: magicLinkIssuer,
      providerId: `magic-link:${person.organization.id}`,
      accountId: person.email,
    });
    const answer = await flow.follow(person.token, person.cookie);
    expect(answer.status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    const [event] = await refusalsOf(person.row.id);
    expect(event!.reason).toBe("account_conflict");
  });

  test("a soft-deleted account of the same person stops it as well", async () => {
    const person = await asked();
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: person.userId,
      issuer: magicLinkIssuer,
      providerId: `magic-link:${person.organization.id}`,
      accountId: person.email,
      deletedAt: new Date(),
    });
    await flow.follow(person.token, person.cookie);
    const [event] = await refusalsOf(person.row.id);
    expect(event!.reason).toBe("account_conflict");
  });
});

describe("refused between issue and confirm", () => {
  const cases: Record<
    string,
    {
      prepare: (person: Awaited<ReturnType<typeof asked>>) => Promise<unknown>;
      reason: string;
      removed?: boolean;
    }
  > = {
    "the member is removed": {
      reason: "access_removed",
      removed: true,
      prepare: (person) =>
        inTenant(fixture.db, person.organization.id, (context) =>
          memberService.remove(context, person.memberId),
        ),
    },
    "the user is disabled": {
      reason: "access_removed",
      removed: true,
      prepare: (person) =>
        fixture.db
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(users.id, person.userId)),
    },
    "the firm turns links off": {
      reason: "not_admitted",
      prepare: (person) => setOff(person.organization.id),
    },
    "the organisation is disabled": {
      reason: "not_admitted",
      prepare: (person) =>
        fixture.db
          .update(organizations)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(organizations.id, person.organization.id)),
    },
    "the domain is disabled": {
      reason: "not_admitted",
      prepare: (person) =>
        fixture.db
          .update(organizationDomains)
          .set({ status: "disabled" })
          .where(eq(organizationDomains.domain, person.organization.domain)),
    },
    "the domain is removed": {
      reason: "not_admitted",
      prepare: (person) =>
        fixture.db
          .update(organizationDomains)
          .set({ status: "disabled", deletedAt: new Date() })
          .where(eq(organizationDomains.domain, person.organization.domain)),
    },
    "the links were turned off and on again": {
      reason: "provider_changed",
      prepare: async (person) => {
        await setOff(person.organization.id);
        await setOn(person.organization.id);
      },
    },
    "the domain moved to another firm": {
      reason: "provider_changed",
      prepare: async (person) => {
        const other = await firm();
        await fixture.db
          .update(organizationDomains)
          .set({ deletedAt: new Date(), status: "disabled" })
          .where(eq(organizationDomains.domain, person.organization.domain));
        await fixture.db.insert(organizationDomains).values({
          id: createId(),
          organizationId: other.id,
          domain: person.organization.domain,
        });
        await fixture.db.insert(members).values({
          id: createId(),
          organizationId: other.id,
          userId: person.userId,
        });
      },
    },
  };

  for (const [name, { prepare, reason, removed }] of Object.entries(cases)) {
    for (const proof of ["link", "code"] as const)
      test(`${name}: the ${proof} signs nobody in`, async () => {
        const person = await asked();
        await prepare(person);
        const response =
          proof === "link"
            ? await flow.follow(person.token, person.cookie)
            : await flow.enter(person.code, person.cookie);
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toEqual([]);
        const text = await response.text();
        if (removed) {
          expect(text).toContain("Your access was removed");
        } else {
          expect(text).toContain(
            proof === "link"
              ? "This link can&#39;t sign you in here"
              : "That code didn&#39;t work",
          );
        }
        const rows = await fixture.db
          .select()
          .from(sessions)
          .where(eq(sessions.authenticationAccountId, person.row.id));
        expect(rows).toEqual([]);
        expect(await flow.sessionsOf(person.userId)).toEqual([]);
        expect(await flow.accountsOf(person.userId)).toEqual([]);
        // Nothing was consumed by a refusal; the request is what ended.
        expect(await flow.tokenRows(person.row.tokenIdentifier!)).toHaveLength(
          1,
        );
        const events = await refusalsOf(person.row.id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: "auth.magic_link.refused",
          actorType: "system",
          actorId: "magic-link",
          outcome: "denied",
          reason,
          organizationId: person.organization.id,
        });
        expect(JSON.stringify(events[0])).not.toContain(person.email);

        // One request writes one audit row, however often it is posted, and the second
        // post reads as a link that no longer works.
        const again =
          proof === "link"
            ? await flow.follow(person.token, person.cookie)
            : await flow.enter(person.code, person.cookie);
        expect(await again.text()).not.toContain("Your access was removed");
        expect(await refusalsOf(person.row.id)).toHaveLength(1);
      });
  }

  test("a holder who changes while the confirmation waits for them refuses", async () => {
    const person = await asked();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const haveLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const command = fixture.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, person.userId))
        .for("update");
      locked();
      await held;
      await tx
        .update(users)
        .set({ email: `moved-${person.userId}@${person.organization.domain}` })
        .where(eq(users.id, person.userId));
      const newcomer = createId();
      await tx.insert(users).values({
        id: newcomer,
        name: "Newcomer",
        email: person.email,
        status: "active",
      });
      await tx.insert(members).values({
        id: createId(),
        organizationId: person.organization.id,
        userId: newcomer,
      });
    });
    await haveLock;
    const answer = flow.follow(person.token, person.cookie);
    await Bun.sleep(150);
    release();
    await command;
    const response = await answer;
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    const [event] = await refusalsOf(person.row.id);
    expect(event!.reason).toBe("provider_changed");
  });

  test("the audit row names the person when there is one, so their history shows it", async () => {
    const person = await asked();
    await setOff(person.organization.id);
    await flow.follow(person.token, person.cookie, {
      "user-agent": "a browser",
    });
    const [event] = await refusalsOf(person.row.id);
    expect(event).toMatchObject({
      targetType: "user",
      targetId: person.userId,
      userAgent: "a browser",
    });
    const subjects = await fixture.db
      .select({ userId: auditEventUsers.userId })
      .from(auditEventUsers)
      .where(eq(auditEventUsers.eventId, event!.id));
    expect(subjects).toEqual([{ userId: person.userId }]);
  });

  test("the audit row keeps no oversized user agent", async () => {
    const person = await asked();
    await setOff(person.organization.id);
    await flow.follow(person.token, person.cookie, {
      "user-agent": "u".repeat(2_000),
    });
    const [event] = await refusalsOf(person.row.id);
    expect(event!.userAgent).toBeNull();
  });

  test("with no such person left, it names the request", async () => {
    const person = await asked();
    await fixture.db
      .update(users)
      .set({ email: `gone-${person.userId}@elsewhere.example.com` })
      .where(eq(users.id, person.userId));
    await flow.follow(person.token, person.cookie);
    const [event] = await refusalsOf(person.row.id);
    expect(event).toMatchObject({
      targetType: "magic_link_request",
      targetId: person.row.id,
      reason: "not_admitted",
    });
  });

  test("a refusal stays one when its audit row cannot be written", async () => {
    const lines: string[] = [];
    const person = await asked();
    await setOff(person.organization.id);
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    await fixture.db.execute(
      sql`alter table audit_events add constraint refuses_for_test check (action <> 'auth.magic_link.refused') not valid`,
    );
    try {
      const response = await flow.follow(person.token, person.cookie);
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      console.error = error;
      await fixture.db.execute(
        sql`alter table audit_events drop constraint refuses_for_test`,
      );
    }
    expect(lines.join()).toContain("magic_link_audit_unavailable");
    expect(lines.join()).not.toContain(person.email);
  });
});

describe("the session trigger", () => {
  test("refuses an origin on an off row, on the restricted runtime login, and accepts it when on", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const accountId = createId();
    await fixture.db.insert(accounts).values({
      id: accountId,
      userId: person.userId,
      issuer: magicLinkIssuer,
      providerId: `magic-link:${organization.id}`,
      accountId: person.email,
    });
    const insert = async () => {
      const [row] = await fixture.db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.id, organization.magicLink.id));
      return withDatabaseScope(fixture.appDb, { kind: "protocol" }, (tx) =>
        tx.insert(sessions).values({
          id: createId(),
          userId: person.userId,
          token: createId(),
          expiresAt: new Date(Date.now() + 60_000),
          authenticationOrganizationId: organization.id,
          authenticationProviderId: organization.magicLink.id,
          authenticationProviderRevision: row!.revision,
          authenticationAccountId: accountId,
        }),
      );
    };
    await insert();
    await setOff(organization.id);
    await expect(insert()).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "session_authentication_origin_provider",
      },
    });
    await setOn(organization.id);
    await insert();
  });

  test("a directory's sign-in is untouched by it", async () => {
    const organization = await firm(true);
    await setOff(organization.id);
    const person = await flow.directorySignIn(organization);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
  });
});

describe("lifetimes", () => {
  const readSession = async (userId: string) =>
    (await flow.sessionsOf(userId))[0]!;

  test("a session ends 24 hours from its creation, however often a page reads it", async () => {
    const person = await asked();
    const response = await flow.follow(person.token, person.cookie);
    const setCookie = response.headers.getSetCookie()[0]!;
    expect(setCookie).toContain(`Max-Age=${magicLinkSessionLifetimeSeconds}`);
    const cookie = flow.signedIn(response);
    const created = await readSession(person.userId);
    const cap =
      created.createdAt.getTime() + magicLinkSessionLifetimeSeconds * 1000;
    expect(created.expiresAt.getTime()).toBe(cap);
    for (const path of ["/login", "/security", "/auth/get-session"]) {
      const read = await fixture.app.request(path, {
        headers: { cookie, origin: fixture.environment.betterAuthUrl },
      });
      expect(read.status, path).toBe(200);
      // Not refreshed: its cookie stays as it was, for the provider's hook to see no sign-in.
      expect(read.headers.getSetCookie(), path).toEqual([]);
      const after = await readSession(person.userId);
      expect(after.expiresAt.getTime(), path).toBe(cap);
      expect(after.updatedAt.getTime(), path).toBe(created.updatedAt.getTime());
    }
  });

  test("the update hook caps what a refresh asks for, for this origin only", async () => {
    const boundary = createSsoOriginBoundary(fixture.db);
    const person = await asked();
    flow.signedIn(await flow.follow(person.token, person.cookie));
    const session = await readSession(person.userId);
    const context = (id: string | undefined) =>
      ({
        context: {
          adapter: fixture.db,
          session: id ? { session: { id } } : null,
        },
      }) as unknown as Parameters<typeof boundary.refresh>[1];
    const cap = new Date(
      session.createdAt.getTime() + magicLinkSessionLifetimeSeconds * 1000,
    );
    const asking = (expiresAt?: Date) =>
      ({
        updatedAt: new Date(),
        ...(expiresAt ? { expiresAt } : {}),
      }) as Parameters<typeof boundary.refresh>[0];
    const later = new Date(Date.now() + 7 * 86_400_000);
    expect(await boundary.refresh(asking(later), context(session.id))).toEqual({
      data: { expiresAt: cap },
    });
    const sooner = new Date(Date.now() + 60_000);
    expect(await boundary.refresh(asking(sooner), context(session.id))).toEqual(
      {
        data: { expiresAt: sooner },
      },
    );
    // An update that moves no expiry, and one that names no session, are left alone.
    expect(
      await boundary.refresh(asking(), context(session.id)),
    ).toBeUndefined();
    expect(
      await boundary.refresh(asking(later), context(undefined)),
    ).toBeUndefined();
    expect(await boundary.refresh(asking(later), null)).toBeUndefined();

    const organization = await firm(true);
    const directory = await flow.directorySignIn(organization);
    const theirs = await readSession(directory.userId);
    expect(
      await boundary.refresh(asking(later), context(theirs.id)),
    ).toBeUndefined();
  });

  test("inside a caller's transaction, the update hook stays on that connection: on a pool of one it would wait for itself", async () => {
    const boundary = createSsoOriginBoundary(fixture.appDb);
    const person = await asked();
    flow.signedIn(await flow.follow(person.token, person.cookie));
    const session = await readSession(person.userId);
    const { adapter } = await fixture.auth.$context;
    const later = new Date(Date.now() + 7 * 86_400_000);
    const answer = await authenticationTransaction(adapter as DBAdapter, () =>
      boundary.refresh(
        { expiresAt: later } as Parameters<typeof boundary.refresh>[0],
        {
          context: { adapter, session: { session: { id: session.id } } },
        } as unknown as Parameters<typeof boundary.refresh>[1],
      ),
    );
    expect(answer).toEqual({ data: { expiresAt: session.expiresAt } });
  });

  test("if a refresh happens all the same, the hook auth.ts installs holds the cap", async () => {
    const person = await asked();
    flow.signedIn(await flow.follow(person.token, person.cookie));
    const session = await readSession(person.userId);
    const authContext = await fixture.auth.$context;
    // What the native session read does, without the skip to stop it.
    await runWithEndpointContext(
      {
        context: {
          ...authContext,
          session: { session: { id: session.id } },
        },
      } as never,
      () =>
        authContext.internalAdapter.updateSession(session.token, {
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        }),
    );
    expect((await readSession(person.userId)).expiresAt.getTime()).toBe(
      session.expiresAt.getTime(),
    );
  });

  test("once past its cap the session is gone from every page", async () => {
    const person = await asked();
    const cookie = flow.signedIn(
      await flow.follow(person.token, person.cookie),
    );
    await fixture.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(sessions.userId, person.userId));
    const text = await (
      await fixture.app.request("/login", { headers: { cookie } })
    ).text();
    expect(text).toContain("Work email");
  });

  test("a directory session keeps Better Auth's week and its refresh", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    const session = await readSession(person.userId);
    const week = 7 * 86_400_000;
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      week,
    );
    // Old enough that a read refreshes it.
    await fixture.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(sessions.id, session.id));
    await fixture.app.request("/login", {
      headers: { cookie: person.cookie },
    });
    const refreshed = await readSession(person.userId);
    expect(
      Math.abs(refreshed.expiresAt.getTime() - (Date.now() + week)),
    ).toBeLessThan(10_000);
  });

  test("a grant lasts seven days here and thirty from a directory, and its refresh token cannot outlive it", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    await flow.allowClient(organization.id);
    const directoryTokens = await flow.issueTokens(
      person.cookie,
      person.memberId,
    );
    const browser = "f".repeat(43);
    await fixture.mail.requests.process({
      address: person.email,
      browser,
      client: "203.0.113.8",
      pendingQuery: null,
    });
    const cookie = flow.signedIn(
      await flow.follow(
        codes(person.email).token,
        `answerable-sign-in=${browser}`,
      ),
    );
    const linkTokens = await flow.issueTokens(cookie, person.memberId);
    const grants = await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.userId, person.userId))
      .orderBy(grantContexts.createdAt);
    const days = (grant: (typeof grants)[number]) =>
      (grant.expiresAt.getTime() - grant.createdAt.getTime()) / 1000;
    expect(days(grants[0]!)).toBe(grantLifetimeSeconds);
    expect(days(grants[1]!)).toBe(magicLinkGrantLifetimeSeconds);
    expect(grants[1]).toMatchObject({
      authenticationProviderId: organization.magicLink.id,
      upstreamAuthTime: null,
    });

    const renewed = await flow.refresh(linkTokens.refresh_token);
    expect(renewed.status).toBe(200);
    const { refresh_token: rotated } = (await renewed.json()) as {
      refresh_token: string;
    };
    // A grant is immutable, so its end has to be brought forward behind the guard's back.
    await fixture.db.execute(
      sql`alter table grant_contexts disable trigger user`,
    );
    await fixture.db.execute(
      sql`update grant_contexts set auth_time = now() - interval '8 days', created_at = now() - interval '8 days', expires_at = now() - interval '1 second' where id = ${grants[1]!.id}`,
    );
    await fixture.db.execute(
      sql`alter table grant_contexts enable trigger user`,
    );
    const stale = await flow.refresh(rotated);
    expect(stale.status).toBe(400);
    expect((await stale.json()).error).toBe("invalid_grant");
    // Only that grant.
    expect((await flow.refresh(directoryTokens.refresh_token)).status).toBe(
      200,
    );
  });
});

describe("authentication_method", () => {
  async function tokensOf(signedInCookie: string, memberId: string) {
    const tokens = (await flow.issueTokens(signedInCookie, memberId)) as {
      access_token?: string;
      refresh_token: string;
    };
    return tokens;
  }

  const claims = (jwt: string) =>
    JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;

  test("a token and UserInfo say how the person signed in, and a refresh keeps it", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const tokens = await tokensOf(cookie, person.memberId);
    const body = claims(tokens.access_token!);
    expect(body.authentication_method).toBe("magic_link");
    expect(body.upstream_auth_time).toBeNull();

    const userinfo = await fixture.app.request("/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({
      sub: person.userId,
      authentication_method: "magic_link",
    });
    const renewed = await flow.refresh(tokens.refresh_token);
    expect(
      claims((await renewed.json()).access_token).authentication_method,
    ).toBe("magic_link");
  });

  test("a directory token says directory", async () => {
    const organization = await firm(true);
    await flow.allowClient(organization.id);
    const person = await flow.directorySignIn(organization);
    const tokens = await tokensOf(person.cookie, person.memberId);
    expect(claims(tokens.access_token!).authentication_method).toBe(
      "directory",
    );
  });

  test("@answerable/auth passes it on from a real token", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const tokens = await tokensOf(cookie, person.memberId);
    const { betterAuthUrl } = fixture.environment;
    const verify = createIdVerifier({
      issuer: betterAuthUrl,
      resource: "https://service.example/magic-link",
      fetch: async (input) => {
        const url = new URL(String(input));
        return fixture.app.fetch(
          new Request(`${betterAuthUrl}${url.pathname}`),
        );
      },
    });
    const principal = await verify(tokens.access_token!);
    expect(principal.authenticationMethod).toBe("magic_link");
    expect(principal.upstreamAuthTime).toBeNull();
    expect(principal.userId).toBe(person.userId);
  });
});

describe("resuming an authorisation", () => {
  async function pendingLogin(extra: Record<string, string> = {}) {
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery(extra)}`,
      {},
    );
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    return location.search.slice(1);
  }

  for (const [name, extra] of [
    ["an ordinary request", {}],
    ["prompt=login", { prompt: "login" }],
    ["max_age=0", { max_age: "0" }],
  ] as const)
    for (const proof of ["link", "code"] as const)
      test(`${name} by ${proof} reaches a code with no loop`, async () => {
        const organization = await firm();
        await flow.allowClient(organization.id);
        const person = await flow.listed(organization);
        const query = await pendingLogin(extra);
        const request = await flow.ask(person.email, { query });
        const [row] = await flow.requestsOf(person.email);
        expect(row!.pendingOauthQuery).toBe(query);
        const response =
          proof === "link"
            ? await flow.follow(request.token!, request.cookie)
            : await flow.enter(request.code!, request.cookie);
        expect(response.status).toBe(303);
        const next = new URL(response.headers.get("location")!);
        expect(next.pathname).toBe("/authorize");
        expect(next.searchParams.has("prompt")).toBe(false);
        expect(next.searchParams.has("max_age")).toBe(false);
        expect(next.toString()).not.toContain(request.token!);
        const cookie = cookieOf(response.headers.getSetCookie());
        const tokens = await flow.finishAuthorization(
          next.search.slice(1),
          cookie,
          person.memberId,
        );
        expect(tokens.refresh_token).toBeString();
        const [grant] = await fixture.db
          .select()
          .from(grantContexts)
          .where(eq(grantContexts.userId, person.userId));
        expect(grant!.authenticationProviderId).toBe(organization.magicLink.id);
      });

  test("what /auth/oauth2/authorize signs fits well inside what a sign-in keeps", async () => {
    const query = await pendingLogin({ prompt: "login" });
    expect(query.length).toBeLessThan(maxPendingQueryLength / 4);
  });

  test("a link that outlives its signed query signs in and lands on /login", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const query = await pendingLogin();
    const request = await flow.ask(person.email, { query });
    const stale = new URLSearchParams(query);
    stale.set("exp", String(Math.floor(Date.now() / 1000) - 1));
    await fixture.db
      .update(magicLinkRequests)
      .set({ pendingOauthQuery: stale.toString() })
      .where(eq(magicLinkRequests.email, person.email));
    const response = await flow.follow(request.token!, request.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    flow.signedIn(response);
  });

  test("a resume the provider cannot finish leaves the person signed in, on /login", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const query = await pendingLogin();
    const request = await flow.ask(person.email, { query });
    // Inside the signature and past the client: the provider answers with no url.
    const realApi = fixture.auth.api.confirmMagicLink;
    fixture.auth.api.confirmMagicLink = (async (input: {
      asResponse: true;
    }) => {
      const answered = (await realApi(input as never)) as Response;
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400,
        headers: answered.headers,
      });
    }) as never;
    try {
      const response = await flow.follow(request.token!, request.cookie);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      flow.signedIn(response);
    } finally {
      fixture.auth.api.confirmMagicLink = realApi;
    }
  });

  test("a resume on someone else's flow is not offered to them", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const first = await flow.listed(organization);
    const second = await flow.listed(organization);
    const query = await pendingLogin();
    const one = await flow.ask(first.email, { query });
    const other = await flow.ask(second.email);
    const signedIn = await flow.follow(one.token!, one.cookie);
    const next = new URL(signedIn.headers.get("location")!);
    const firstCookie = cookieOf(signedIn.headers.getSetCookie());
    const secondCookie = flow.signedIn(
      await flow.follow(other.token!, other.cookie),
    );
    // The flow belongs to whoever opened it first.
    await flow.finishAuthorization(
      next.search.slice(1),
      firstCookie,
      first.memberId,
    );
    const replay = await flow.protocol("/oauth2/continue", {
      cookie: secondCookie,
      json: {
        oauth_query: next.search.slice(1),
        postLogin: true,
        memberId: second.memberId,
      },
    });
    expect(replay.status).toBe(400);
  });
});

describe("choosing a links-only firm on the selection page", () => {
  /** An application starts an authorisation in this browser; the page offers its firms. */
  async function selection(cookie: string) {
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      { cookie },
    );
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location")!);
    expect(location.pathname).toBe("/authorize");
    const page = await fixture.app.request(`/authorize${location.search}`, {
      headers: { cookie },
    });
    return { query: location.search.slice(1), text: await page.text() };
  }

  const choose = (query: string, memberId: string, cookie: string) =>
    flow.post(`/authorize?${query}`, { member: memberId }, { cookie });

  function expectAddressForm(text: string, query: string) {
    expect(text).toContain("Work email");
    expect(text).toContain(`action="/login?${query.replaceAll("&", "&amp;")}"`);
    expect(text).not.toContain('role="alert"');
    expect(text).not.toContain("couldn&#39;t start");
  }

  test("a stale session after off then on asks for the address, and goes through to a code", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    const stale = flow.signedIn(await flow.follow(first.token!, first.cookie));
    await setOff(organization.id);
    await setOn(organization.id);

    const { query, text } = await selection(stale);
    expect(text).toContain(organization.slug);
    const chosen = await choose(query, person.memberId, stale);
    expect(chosen.status).toBe(200);
    expect(chosen.headers.getSetCookie()).toEqual([]);
    expectAddressForm(await chosen.text(), query);

    // A person who reloads posts the same form; the mail carries the query they came with.
    const second = await flow.ask(person.email, {
      query,
      cookie: stale,
      headers: { "cf-connecting-ip": "198.51.100.91" },
    });
    expect(second.mail).toBeDefined();
    const rows = await flow.requestsOf(person.email);
    expect(rows.at(-1)!.pendingOauthQuery).toBe(query);

    const response = await flow.follow(second.token!, second.cookie);
    expect(response.status).toBe(303);
    const next = new URL(response.headers.get("location")!);
    expect(next.pathname).toBe("/authorize");
    const fresh = cookieOf(response.headers.getSetCookie());
    // The new session has standing, so the same choice now goes straight on.
    const tokens = await flow.finishAuthorization(
      next.search.slice(1),
      fresh,
      person.memberId,
    );
    expect(tokens.refresh_token).toBeString();
    const [grant] = await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.userId, person.userId));
    expect(grant!.authenticationProviderRevision).toBeGreaterThan(
      organization.magicLink.revision,
    );
  });

  test("the same choice by code goes through to a code too", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    const stale = flow.signedIn(await flow.follow(first.token!, first.cookie));
    await setOff(organization.id);
    await setOn(organization.id);
    const { query } = await selection(stale);
    expectAddressForm(
      await (await choose(query, person.memberId, stale)).text(),
      query,
    );
    const second = await flow.ask(person.email, {
      query,
      headers: { "cf-connecting-ip": "198.51.100.92" },
    });
    const response = await flow.enter(second.code!, second.cookie);
    const next = new URL(response.headers.get("location")!);
    expect(next.pathname).toBe("/authorize");
    const tokens = await flow.finishAuthorization(
      next.search.slice(1),
      cookieOf(response.headers.getSetCookie()),
      person.memberId,
    );
    expect(tokens.refresh_token).toBeString();
  });

  test("a live directory session at another firm gets the form, with no error", async () => {
    const directoryFirm = await firm(true);
    const linksFirm = await firm();
    await flow.allowClient(directoryFirm.id);
    await flow.allowClient(linksFirm.id);
    const person = await flow.directorySignIn(directoryFirm);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: linksFirm.id,
      userId: person.userId,
    });
    const { query, text } = await selection(person.cookie);
    expect(text).toContain(linksFirm.slug);
    const chosen = await choose(query, memberId, person.cookie);
    expect(chosen.status).toBe(200);
    expectAddressForm(await chosen.text(), query);
    // Their session was left alone, and their own firm still goes straight on.
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    const own = await choose(query, person.memberId, person.cookie);
    expect(own.status).toBe(302);
    expect(new URL(own.headers.get("location")!).pathname).toBe("/consent");
  });

  test("that person's own address gets no mail at the other firm: an account of another firm's directory makes a stranger", async () => {
    const directoryFirm = await firm(true);
    const linksFirm = await firm();
    await flow.allowClient(directoryFirm.id);
    await flow.allowClient(linksFirm.id);
    const person = await flow.directorySignIn(directoryFirm);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: linksFirm.id,
      userId: person.userId,
    });
    // Their address moves to the firm they chose, as the only way it could route there.
    const moved = `person-${createId()}@${linksFirm.domain}`;
    await fixture.db
      .update(users)
      .set({ email: moved })
      .where(eq(users.id, person.userId));
    const { query } = await selection(person.cookie);
    const asked = await flow.ask(moved, { query, cookie: person.cookie });
    expect(asked.response.status).toBe(200);
    expect(await asked.response.text()).toContain("Check your email");
    expect(asked.mail).toBeUndefined();
    expect(await flow.requestsOf(moved)).toEqual([]);
  });

  test("another person of that firm signs in, is refused this flow as it is bound, and reaches a code from the application", async () => {
    const directoryFirm = await firm(true);
    const linksFirm = await firm();
    await flow.allowClient(directoryFirm.id);
    await flow.allowClient(linksFirm.id);
    const person = await flow.directorySignIn(directoryFirm);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: linksFirm.id,
      userId: person.userId,
    });
    const other = await flow.listed(linksFirm);
    const { query } = await selection(person.cookie);
    expectAddressForm(
      await (await choose(query, memberId, person.cookie)).text(),
      query,
    );
    const request = await flow.ask(other.email, { query });
    const response = await flow.follow(request.token!, request.cookie);
    expect(response.status).toBe(303);
    const next = new URL(response.headers.get("location")!);
    expect(next.pathname).toBe("/authorize");
    const cookie = cookieOf(response.headers.getSetCookie());
    // The flow belongs to whoever opened it first, so it is not handed to this person.
    const page = await fixture.app.request(`/authorize${next.search}`, {
      headers: { cookie },
    });
    expect(await page.text()).toContain("Start again from the application");
    const tokens = await flow.issueTokens(cookie, other.memberId);
    expect(tokens.refresh_token).toBeString();
  });

  test("a session read inside an authorisation's transaction stays on its connection: on a pool of one nothing waits", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const { query } = await selection(cookie);
    const pool = (
      fixture.appDb as unknown as { $client: { waitingCount: number } }
    ).$client;
    let waited = 0;
    const sampling = setInterval(() => {
      waited = Math.max(waited, pool.waitingCount);
    }, 1);
    try {
      await flow.finishAuthorization(query, cookie, person.memberId);
    } finally {
      clearInterval(sampling);
    }
    expect(waited).toBe(0);
  });

  test("an authenticated member of a links-only firm goes straight on", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const { query } = await selection(cookie);
    const chosen = await choose(query, person.memberId, cookie);
    expect(chosen.status).toBe(302);
    expect(new URL(chosen.headers.get("location")!).pathname).toBe("/consent");
  });

  test("a firm with neither links nor a directory answers as it did", async () => {
    const directoryFirm = await firm(true);
    const off = await firm();
    await flow.allowClient(directoryFirm.id);
    await flow.allowClient(off.id);
    await setOff(off.id);
    const person = await flow.directorySignIn(directoryFirm);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: off.id,
      userId: person.userId,
    });
    const { query } = await selection(person.cookie);
    const chosen = await choose(query, memberId, person.cookie);
    expect(chosen.status).toBe(200);
    const text = await chosen.text();
    expect(text).toContain(
      "We couldn&#39;t start your organisation&#39;s sign-in",
    );
    expect(text).not.toContain("Work email");
  });

  test("a firm with a directory still starts its sign-in", async () => {
    const mine = await firm(true);
    const theirs = await firm(true);
    await flow.allowClient(mine.id);
    await flow.allowClient(theirs.id);
    const person = await flow.directorySignIn(mine);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: theirs.id,
      userId: person.userId,
    });
    const { query } = await selection(person.cookie);
    const chosen = await choose(query, memberId, person.cookie);
    expect(chosen.status).toBe(302);
    expect(chosen.headers.get("location")).toContain(fixture.issuer.origin);
  });
});

describe("firm isolation", () => {
  test("a person's session and grants answer to their own firm's row, and another firm's switch touches nothing", async () => {
    const mine = await firm();
    const theirs = await firm();
    await flow.allowClient(mine.id);
    const person = await flow.listed(mine);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    const tokens = await flow.issueTokens(cookie, person.memberId);
    await setOff(theirs.id);
    expect((await flow.refresh(tokens.refresh_token)).status).toBe(200);
    const page = await fixture.app.request("/login", { headers: { cookie } });
    expect(await page.text()).toContain("Signed in as");
    // And a member elsewhere is a stranger at this firm's address.
    const elsewhere = await flow.listed(theirs);
    await setOn(theirs.id);
    const asked = await flow.ask(
      `${elsewhere.email.split("@")[0]}@${mine.domain}`,
    );
    expect(asked.mail).toBeUndefined();
  });
});

describe("off means off", () => {
  async function signedInPerson() {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const request = await flow.ask(person.email);
    const cookie = flow.signedIn(
      await flow.follow(request.token!, request.cookie),
    );
    return { organization, ...person, cookie };
  }
  const page = async (path: string, cookie: string) =>
    (await fixture.app.request(path, { headers: { cookie } })).text();

  test("a session on a row that is off or changed reads as signed out, and stays out when back on", async () => {
    const person = await signedInPerson();
    const tokens = await flow.issueTokens(person.cookie, person.memberId);
    expect(await page("/login", person.cookie)).toContain("Signed in as");
    expect(await page("/security", person.cookie)).toContain(
      `Signed in as ${person.email}`,
    );
    await setOff(person.organization.id);
    for (const moment of ["off", "back on"]) {
      const login = await page("/login", person.cookie);
      expect(login, moment).toContain("Work email");
      expect(login, moment).not.toContain("Signed in as");
      const security = await page("/security", person.cookie);
      expect(security, moment).not.toContain("Signed in as");
      expect(security, moment).toContain("Sign in");
      expect((await flow.refresh(tokens.refresh_token)).status).toBe(400);
      await setOn(person.organization.id);
    }
  });

  test("a session at an off row's current revision, which nothing can make any more, reads as signed out too", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    await setOff(organization.id);
    await fixture.db.execute(sql`alter table sessions disable trigger user`);
    const { cookie } = await flow.magicLinkSession(organization, person);
    await fixture.db.execute(sql`alter table sessions enable trigger user`);
    const login = await page("/login", cookie);
    expect(login).not.toContain("Signed in as");
    expect(login).toContain("Work email");
  });

  test("with a pending authorisation it asks again rather than sending the person on", async () => {
    const person = await signedInPerson();
    await setOff(person.organization.id);
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      {},
    );
    const login = new URL(started.headers.get("location")!);
    const response = await fixture.app.request(`/login${login.search}`, {
      headers: { cookie: person.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Work email");
  });

  test("a live one with a pending authorisation goes straight on", async () => {
    const person = await signedInPerson();
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      {},
    );
    const login = new URL(started.headers.get("location")!);
    const response = await fixture.app.request(`/login${login.search}`, {
      headers: { cookie: person.cookie },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/authorize?");
  });

  test("a directory session's pages are unchanged when the firm's links go off", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    await setOff(organization.id);
    const login = await page("/login", person.cookie);
    expect(login).toContain("Signed in as");
    expect(login).toContain("Verify sign-in or connect a work account");
    const security = await page("/security", person.cookie);
    expect(security).toContain("Verify sign-in");
    expect(security).toContain("Connect another work account");
  });

  test("a magic-link session sees no directory actions, and the right words", async () => {
    const person = await signedInPerson();
    const login = await page("/login", person.cookie);
    expect(login).not.toContain("connect a work account");
    const security = await page("/security", person.cookie);
    expect(security).toContain("link sent to your email");
    expect(security).not.toContain("Verify sign-in");
    expect(security).not.toContain("Connect another work account");
    expect(security).not.toContain('action="/security/verify"');
  });
});

describe("administrative authority", () => {
  test("a magic-link session holds none, whatever its entitlements; the same person's directory session keeps it, and the views agree", async () => {
    const tenant = fixture.principals.tenantAdmin;
    const [{ email }] = (await fixture.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, tenant.userId))) as [{ email: string }];
    const browser = "a".repeat(43);
    await fixture.mail.requests.process({
      address: email,
      browser,
      client: "203.0.113.9",
      pendingQuery: null,
    });
    const cookie = flow.signedIn(
      await flow.follow(codes(email).token, `answerable-sign-in=${browser}`),
    );
    const route = `/api/admin/v1/organizations/${tenant.organizationId}`;
    const read = (session: string) =>
      fixture.app.request(route, {
        headers: {
          cookie: session,
          origin: fixture.trustedOrigin,
        },
      });
    expect((await read(cookie)).status).toBe(404);
    expect((await read(tenant.cookie)).status).toBe(200);

    // The person has both accounts here, so the member still reports it: a directory session holds it.
    const view = async (memberId: string) => {
      const response = await fixture.app.request(
        `/api/admin/v1/organizations/${tenant.organizationId}/members/${memberId}/access`,
        { headers: fixture.headers("platformAdmin") },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        targets: {
          kind: string;
          permission: { allowed: boolean; reason: string };
        }[];
      };
    };
    const both = await view(tenant.memberId);
    expect(
      both.targets.find((target) => target.kind === "resource")?.permission
        .allowed,
    ).toBe(true);

    // A member who signs in by link alone does not report it.
    const single = await flow.listed({
      id: tenant.organizationId,
      domain: "tenant.example.com",
    });
    await fixture.db.insert(accounts).values({
      id: createId(),
      userId: single.userId,
      issuer: magicLinkIssuer,
      providerId: `magic-link:${tenant.organizationId}`,
      accountId: single.email,
    });
    const { entitlements } = await import("../db/schema/index.ts");
    await fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId: tenant.organizationId,
      memberId: single.memberId,
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
    });
    const linkOnly = await view(single.memberId);
    expect(
      linkOnly.targets.find((target) => target.kind === "resource")?.permission,
    ).toEqual({ allowed: false, reason: "directory_sign_in" });
    const listed = await fixture.app.request(
      `/api/admin/v1/organizations/${tenant.organizationId}/access?resource=${encodeURIComponent(fixture.platform.adminResource)}`,
      { headers: fixture.headers("platformAdmin") },
    );
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as {
      items: {
        memberId: string;
        permission: { allowed: boolean; reason?: string };
      }[];
    };
    expect(
      items.find((item) => item.memberId === single.memberId)?.permission,
    ).toEqual({ allowed: false, reason: "directory_sign_in" });
    expect(
      items.find((item) => item.memberId === tenant.memberId)?.permission
        .allowed,
    ).toBe(true);
  });
});

test("nothing of a browser's cookie or a code is stored anywhere readable", async () => {
  const person = await asked();
  const browser = person.cookie.split("=")[1]!;
  const rows = await fixture.db
    .select()
    .from(magicLinkRequests)
    .where(eq(magicLinkRequests.id, person.row.id));
  const all = JSON.stringify(rows);
  expect(all).not.toContain(browser);
  expect(all).not.toContain(person.code);
  expect(rows[0]!.browserHash).toBe(
    createHash("sha256").update(browser).digest("base64url"),
  );
  const tokens = await fixture.db
    .select()
    .from(verifications)
    .where(like(verifications.identifier, "magic-link:%"));
  expect(JSON.stringify(tokens)).not.toContain(person.token);
});
