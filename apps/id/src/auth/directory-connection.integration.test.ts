import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { decodeJwt } from "jose";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { cookiesAfter, magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { codeIn } from "../__tests__/magic-link-requests.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import { createApp } from "../app.ts";
import { maxPendingQueryLength } from "../http/pages/login-routing.ts";
import {
  accounts,
  auditEvents,
  entitlements,
  magicLinkRequests,
  members,
  organizationDomains,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  deleteOrganizationDomain,
  disableDomain,
} from "../services/domains.ts";
import { magicLinkCodeBudgets } from "../services/magic-link-codes.ts";
import {
  createMagicLinkRequests,
  magicLinkLimits,
} from "../services/magic-link-requests.ts";
import * as memberService from "../services/members.ts";
import {
  disableMagicLink,
  disableOrganization,
  setMagicLinkAdmission,
} from "../services/organizations.ts";
import {
  deleteSsoProvider,
  putSsoProvider,
} from "../services/sso-providers.ts";
import { disableUser, eraseUser, retireUserEmail } from "../services/users.ts";
import { magicLinkIssuer, magicLinkKeys } from "./magic-link.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  // A pool of one: nothing here may need a second connection, audit rows included.
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(() => fixture?.close());

let nextFirm = 0;
const firm = (directory = true) =>
  flow.seedOrganization(`connect-${++nextFirm}`, directory);
type Firm = Awaited<ReturnType<typeof firm>>;

const setLinks = (of: Firm, enabled: boolean) =>
  fixture.db
    .update(ssoProviders)
    .set({ enabled })
    .where(eq(ssoProviders.id, of.magicLink.id));

const subject = () => `subject-${createId()}`;

const errorOf = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("error");

async function refusalsOf(requestId: string) {
  return flow.refusals("auth.magic_link.refused", requestId);
}

/** The person's one request of this purpose. */
async function connectionOf(email: string) {
  const rows = await flow.requestsOf(email);
  const held = rows.filter((row) => row.purpose === "connect_directory");
  expect(held).toHaveLength(1);
  return held[0]!;
}

const linkedEvents = async (accountId: string) =>
  fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "identity.linked"),
        eq(auditEvents.targetId, accountId),
      ),
    );

/** A listed person, part way: signed in at the directory, with the mail in their inbox. */
async function waiting(of: Firm, sub = subject()) {
  const person = await flow.listed(of);
  const signIn = await flow.signInByDirectory(person.email, sub);
  expect(signIn.response.headers.get("location")).toBe("/connect-directory");
  return { ...person, ...signIn, sub };
}
type Waiting = Awaited<ReturnType<typeof waiting>>;

/** The rest of the flow: the right code, then the directory again, for a session. */
async function finish({
  code,
  cookie,
  email,
  sub,
}: Pick<Waiting, "code" | "cookie" | "email" | "sub">) {
  const entered = await flow.enterConnectionCode(code!, cookie);
  expect(entered.status).toBe(303);
  return flow.throughDirectory(
    entered,
    { sub, email, name: "Person" },
    { cookie },
  );
}

const wrong = (code: string) => (code === "00000000" ? "11111111" : "00000000");

/** The choice page's other button. */
const askLink = (email: string, options: Parameters<typeof flow.ask>[1] = {}) =>
  flow.ask(email, { ...options, method: "link" });

describe("the first proof: the directory has verified someone whose address is held", () => {
  test("no session and no account; the identity is stored against the browser, for ten minutes, with nothing else of the sign-in", async () => {
    const of = await firm();
    const person = await waiting(of);
    const { response, cookie, mail, code, email, userId, sub } = person;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/connect-directory");
    expect(await flow.sessionsOf(userId)).toEqual([]);
    expect(await flow.accountsOf(userId)).toEqual([]);
    expect(cookie).not.toContain("session_token");

    const row = await connectionOf(email);
    expect(row).toMatchObject({
      organizationId: of.id,
      providerId: of.row!.id,
      providerRevision: of.row!.revision,
      directoryIssuer: fixture.issuer.origin,
      directorySubject: sub,
      directoryUserId: sub,
      tokenIdentifier: null,
      newAddress: false,
      attempts: 0,
      sendStatus: "sent",
      pendingOauthQuery: null,
    });
    expect(row.browserHash).toBeString();
    expect(row.codeHmac).toBeString();
    // Nothing of the sign-in lands anywhere else: no token, no row of `verifications`.
    expect(
      await fixture.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, `magic-link:${email}`)),
    ).toEqual([]);
    const [{ lifetime }] = (await fixture.db
      .select({
        lifetime: sql<number>`extract(epoch from ${magicLinkRequests.expiresAt} - ${magicLinkRequests.createdAt})::int`,
      })
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.id, row.id))) as [{ lifetime: number }];
    expect(Math.abs(lifetime - 600)).toBeLessThan(5);

    expect(mail!.subject).toContain("code");
    expect(mail!.text).toContain("Do not give this code to anyone.");
    expect(mail!.text).toContain(
      "Nobody at your firm or at this service will ask for it.",
    );
    expect(mail!.text).not.toContain("http");
    expect(mail!.text).toContain(of.slug);
    expect(code).toMatch(/^\d{8}$/);

    const page = await flow.openConnection(cookie);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Connect your company sign-in");
    expect(text).toContain(email);
    expect(text).toContain('action="/connect-directory"');
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain(code!);
  });

  test("the callback, a top-level GET from the directory, gives a browser with no cookie one that `SameSite=Lax` will send back", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const { response } = await flow.signInByDirectory(person.email, subject());
    const set = response.headers
      .getSetCookie()
      .find((line) => line.startsWith("answerable-sign-in="))!;
    expect(set).toMatch(/^answerable-sign-in=[A-Za-z0-9_-]{43};/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=600");
    // Its state cookie's clearing comes through with it.
    expect(
      response.headers.getSetCookie().filter((line) => /max-age=0/i.test(line)),
    ).not.toEqual([]);
  });

  test("a browser that already holds a cookie keeps it, and a malformed one is replaced", async () => {
    const of = await firm();
    const held = `answerable-sign-in=${"k".repeat(43)}`;
    const kept = await flow.listed(of);
    const signIn = await flow.signInByDirectory(kept.email, subject(), {
      cookie: held,
    });
    expect(signIn.cookie).toContain(held);
    expect((await flow.openConnection(held)).status).toBe(200);

    const replaced = await flow.listed(of);
    const again = await flow.signInByDirectory(replaced.email, subject(), {
      cookie: "answerable-sign-in=short",
    });
    expect(again.cookie).not.toContain("answerable-sign-in=short");
    expect(await (await flow.openConnection(again.cookie)).text()).toContain(
      replaced.email,
    );
  });

  test("a directory that has already changed is named at the revision it has now, and a person connects", async () => {
    const of = await firm();
    await inPlatformWrite(fixture.db, (context) =>
      putSsoProvider(context, of.id, {
        ...flow.directoryInput(of.slug),
        domain: `moved.${of.domain}`,
      }),
    );
    const [directory] = await fixture.db
      .select({ revision: ssoProviders.revision })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, of.row!.id));
    expect(directory!.revision).toBeGreaterThan(of.row!.revision);
    const person = await waiting(of);
    expect((await connectionOf(person.email)).providerRevision).toBe(
      directory!.revision,
    );
    expect(
      (await flow.enterConnectionCode(person.code!, person.cookie)).status,
    ).toBe(303);
  });

  test("an address the directory writes in capitals is the one the firm holds", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const signIn = await flow.signInByDirectory(person.email, subject(), {
      claims: { email: person.email.toUpperCase() },
    });
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    expect((await connectionOf(person.email)).email).toBe(person.email);
  });

  test("it writes lines for an operator, none of them a rejection, and names the purpose", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const client = "198.18.200.20";
    const { error, log } = console;
    const lines: string[] = [];
    const keep = (...args: unknown[]) => void lines.push(args.join(" "));
    Object.assign(console, { log: keep, error: keep });
    try {
      await flow.signInByDirectory(person.email, subject(), { client });
      await flow.signInByDirectory(person.email, subject(), { client });
    } finally {
      Object.assign(console, { error, log });
    }
    const text = lines.join("\n");
    expect(text).not.toContain("signin_rejected");
    expect(text).toContain('"outcome":"sent"');
    expect(text).toContain('"purpose":"connect_directory"');
    expect(text).toContain('"outcome":"limited"');
    expect(text).toContain('"limit":"address_client_minute"');
    expect(text).not.toContain(person.email);
  });

  describe("everything else keeps email_conflict: no row, no mail, no cookie", () => {
    const seed: Record<
      string,
      (of: Firm) => Promise<{ email: string; userId?: string }>
    > = {
      "a disabled holder": async (of) => {
        const person = await flow.listed(of);
        await fixture.db
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(users.id, person.userId));
        return person;
      },
      "a removed member": async (of) => {
        const person = await flow.listed(of);
        await fixture.db
          .update(members)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(members.id, person.memberId));
        return person;
      },
      "a membership that has ended": async (of) => {
        const person = await flow.listed(of);
        await fixture.db
          .update(members)
          .set({
            validFrom: new Date(Date.now() - 7_200_000),
            validUntil: new Date(Date.now() - 3_600_000),
          })
          .where(eq(members.id, person.memberId));
        return person;
      },
      "a membership that has not begun": async (of) => {
        const person = await flow.listed(of);
        await fixture.db
          .update(members)
          .set({ validFrom: new Date(Date.now() + 3_600_000) })
          .where(eq(members.id, person.memberId));
        return person;
      },
      "no membership here": async (of) => {
        const userId = createId();
        const email = `no-member-${userId}@${of.domain}`;
        await fixture.db.insert(users).values({
          id: userId,
          name: "No member",
          email,
          emailVerified: true,
          status: "active",
        });
        return { email, userId };
      },
      "a membership at another firm only": async (of) => {
        const other = await firm();
        const userId = createId();
        const email = `elsewhere-${userId}@${of.domain}`;
        await fixture.db.insert(users).values({
          id: userId,
          name: "Elsewhere",
          email,
          emailVerified: true,
          status: "active",
        });
        await fixture.db.insert(members).values({
          id: createId(),
          organizationId: other.id,
          userId,
        });
        return { email, userId };
      },
      "an account from another firm's directory": async (of) => {
        const other = await firm();
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: fixture.issuer.origin,
          providerId: other.row!.providerId,
          accountId: subject(),
        });
        return person;
      },
      "an account from another firm's magic-link row": async (of) => {
        const other = await firm();
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: magicLinkIssuer,
          providerId: other.magicLink.providerId,
          accountId: person.email,
        });
        return person;
      },
      "an account no provider row names": async (of) => {
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: "https://gone.example",
          providerId: "gone",
          accountId: subject(),
        });
        return person;
      },
      "a live account of this directory with another subject": async (of) => {
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: fixture.issuer.origin,
          providerId: of.row!.providerId,
          accountId: subject(),
        });
        return person;
      },
      "a tombstone of this directory's account": async (of) => {
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: fixture.issuer.origin,
          providerId: of.row!.providerId,
          accountId: subject(),
          deletedAt: new Date(),
          refreshToken: null,
        });
        return person;
      },
      "a tombstone of this firm's own magic-link account": async (of) => {
        const person = await flow.listed(of);
        await fixture.db.insert(accounts).values({
          id: createId(),
          userId: person.userId,
          issuer: magicLinkIssuer,
          providerId: of.magicLink.providerId,
          accountId: person.email,
          deletedAt: new Date(),
          refreshToken: null,
        });
        return person;
      },
    };
    for (const [name, make] of Object.entries(seed))
      test(name, async () => {
        const of = await firm();
        const { email, userId } = await make(of);
        const sent = fixture.mail.transport.sent.length;
        const { response } = await flow.signInByDirectory(email, subject());
        expect(errorOf(response)).toBe("email_conflict");
        expect(new URL(response.headers.get("location")!).pathname).toBe(
          "/error",
        );
        expect(await flow.requestsOf(email)).toEqual([]);
        expect(fixture.mail.transport.sent).toHaveLength(sent);
        expect(
          response.headers
            .getSetCookie()
            .filter((line) => line.startsWith("answerable-sign-in")),
        ).toEqual([]);
        if (userId) expect(await flow.sessionsOf(userId)).toEqual([]);
      });

    test("an account from this firm's removed directory", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: person.userId,
        issuer: "https://old.example",
        providerId: of.row!.providerId,
        accountId: subject(),
      });
      await inPlatformWrite(fixture.db, (context) =>
        deleteSsoProvider(context, of.id),
      );
      await createSsoProvider(fixture.db, {
        ...flow.directoryInput(of.slug),
        organizationId: of.id,
        providerId: of.slug,
      });
      const { response } = await flow.signInByDirectory(
        person.email,
        subject(),
      );
      expect(errorOf(response)).toBe("email_conflict");
    });

    test("a magic-link account of this firm does not stand in the way: it is the point", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: person.userId,
        issuer: magicLinkIssuer,
        providerId: of.magicLink.providerId,
        accountId: person.email,
      });
      const { response } = await flow.signInByDirectory(
        person.email,
        subject(),
      );
      expect(response.headers.get("location")).toBe("/connect-directory");
    });

    test("a retired address is free, so a new identity is a new person with a new `sub`", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      await inPlatformUsers(fixture.db, (context) =>
        disableUser(context, person.userId),
      );
      await inPlatformUsers(fixture.db, (context) =>
        retireUserEmail(context, person.userId),
      );
      const { response } = await flow.signInByDirectory(
        person.email,
        subject(),
      );
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/login",
      );
      const [holder] = await fixture.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, person.email));
      expect(holder!.id).not.toBe(person.userId);
    });
  });

  describe("an identity comes only from a verified callback in this request", () => {
    test("a forged `error=` on the callback, with a real state, stores nothing and sends nothing", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const sent = fixture.mail.transport.sent.length;
      const started = await flow.post(`/login`, {
        email: person.email,
        method: "directory",
      });
      const state = new URL(started.headers.get("location")!).searchParams.get(
        "state",
      )!;
      const forged = await fixture.app.request(
        `/auth/sso/callback?state=${encodeURIComponent(state)}&error=email_conflict&email=${encodeURIComponent(person.email)}&sub=forged`,
        {
          headers: {
            cookie: cookiesAfter("", started.headers.getSetCookie()),
          },
        },
      );
      expect(errorOf(forged)).toBe("email_conflict");
      expect(new URL(forged.headers.get("location")!).pathname).toBe("/error");
      expect(await flow.requestsOf(person.email)).toEqual([]);
      expect(fixture.mail.transport.sent).toHaveLength(sent);
      expect(forged.headers.getSetCookie().join()).not.toContain(
        "answerable-sign-in",
      );
    });

    test("a direct GET of the page, of any shape, with no stored proof, gets nothing", async () => {
      const of = await firm();
      const person = await waiting(of);
      for (const cookie of [
        "",
        "answerable-sign-in=short",
        `answerable-sign-in=${"n".repeat(43)}`,
      ])
        for (const query of [
          "",
          `?issuer=${encodeURIComponent(fixture.issuer.origin)}&subject=forged&email=${encodeURIComponent(person.email)}`,
          "?error=email_conflict",
        ]) {
          const answer = await fixture.app.request(
            `/connect-directory${query}`,
            { headers: cookie ? { cookie } : {} },
          );
          expect(answer.status).toBe(200);
          const text = await answer.text();
          expect(text).toContain("No code is waiting in this browser");
          expect(text).not.toContain(person.email);
          expect(text).not.toContain("<form");
        }
    });

    test("nothing a form says about an identity reaches the row", async () => {
      const of = await firm();
      const person = await waiting(of);
      const answer = await flow.post(
        "/connect-directory",
        {
          code: wrong(person.code!),
          issuer: "https://evil.example",
          subject: "forged",
          email: `evil@${of.domain}`,
        },
        { cookie: person.cookie },
      );
      expect(answer.status).toBe(200);
      const row = await connectionOf(person.email);
      expect(row.directorySubject).toBe(person.sub);
      expect(row.directoryIssuer).toBe(fixture.issuer.origin);
      const right = await flow.post(
        "/connect-directory",
        { code: person.code!, subject: "forged" },
        { cookie: person.cookie },
      );
      expect(right.status).toBe(303);
      const [account] = await flow.accountsOf(person.userId);
      expect(account!.accountId).toBe(person.sub);
    });

    test("a browser with no service to mail through, and a failure asking, leave the refusal as it was", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const answers: Response[] = [];
      for (const magicLinks of [
        undefined,
        {
          request: () => false,
          connectDirectory: () => Promise.reject(new Error("unavailable")),
        },
      ]) {
        const app = createApp({
          auth: fixture.auth,
          db: fixture.db,
          environment: fixture.environment,
          magicLinks,
        });
        const started = await app.request("/login", {
          method: "POST",
          headers: {
            origin: fixture.environment.betterAuthUrl,
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": `198.18.200.${answers.length + 1}`,
          },
          body: new URLSearchParams({
            email: person.email,
            method: "directory",
          }),
        });
        fixture.issuer.enqueue({
          sub: subject(),
          email: person.email,
          email_verified: true,
          auth_time: Math.floor(Date.now() / 1000),
        });
        const upstream = await fetch(started.headers.get("location")!, {
          redirect: "manual",
        });
        const callback = new URL(upstream.headers.get("location")!);
        const logged: string[] = [];
        const { error } = console;
        console.error = (...args: unknown[]) =>
          void logged.push(args.join(" "));
        try {
          answers.push(
            await app.request(callback.pathname + callback.search, {
              headers: {
                cookie: cookiesAfter("", started.headers.getSetCookie()),
              },
            }),
          );
        } finally {
          console.error = error;
        }
        expect(logged.join().includes("magic_link_job_failed")).toBe(
          magicLinks !== undefined,
        );
        // The refusal's own line: an operator sees it as any other.
        expect(logged.join()).toContain("signin_rejected");
      }
      for (const answer of answers) {
        expect(errorOf(answer)).toBe("email_conflict");
        expect(answer.headers.getSetCookie().join()).not.toContain(
          "answerable-sign-in",
        );
      }
    });
  });

  describe("the mail limits apply, with a link's requests counted beside it", () => {
    test("a second sign-in in the minute sends nothing new and the browser keeps its first code", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const client = "198.18.201.1";
      const first = await flow.signInByDirectory(person.email, subject(), {
        client,
      });
      const sent = fixture.mail.transport.sent.length;
      const second = await flow.signInByDirectory(person.email, subject(), {
        client,
        cookie: first.cookie,
      });
      expect(second.response.headers.get("location")).toBe(
        "/connect-directory",
      );
      expect(second.mail).toBeUndefined();
      expect(fixture.mail.transport.sent).toHaveLength(sent);
      expect(await flow.requestsOf(person.email)).toHaveLength(1);
      expect(await (await flow.openConnection(first.cookie)).text()).toContain(
        person.email,
      );
    });

    test("a limited browser that holds no code is told nothing is waiting", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const client = "198.18.201.2";
      await flow.signInByDirectory(person.email, subject(), { client });
      const other = await flow.signInByDirectory(person.email, subject(), {
        client,
      });
      expect(other.response.headers.get("location")).toBe("/connect-directory");
      expect(await (await flow.openConnection(other.cookie)).text()).toContain(
        "No code is waiting",
      );
    });

    test("a link just asked for counts, and a connection counts against the next link", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const client = "198.18.201.3";
      await askLink(person.email, {
        headers: { "cf-connecting-ip": client },
      });
      const after = await flow.signInByDirectory(person.email, subject(), {
        client,
      });
      expect(after.mail).toBeUndefined();

      const other = await flow.listed(of);
      await flow.signInByDirectory(other.email, subject(), { client });
      const link = await askLink(other.email, {
        headers: { "cf-connecting-ip": client },
      });
      expect(link.mail).toBeUndefined();
    });

    test("a client at its budget for addresses nobody holds still connects: this person is not new", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const client = "198.18.201.7";
      const clientHash = magicLinkKeys(fixture.environment).clientHash(client);
      const stranger = await firm();
      await fixture.db.insert(magicLinkRequests).values(
        Array.from({ length: magicLinkLimits.newAddressClientPerHour }, () => ({
          id: createId(),
          organizationId: stranger.id,
          providerId: stranger.magicLink.id,
          providerRevision: stranger.magicLink.revision,
          purpose: "access_removed" as const,
          email: `made-up-${createId()}@${stranger.domain}`,
          clientHash,
          newAddress: true,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
      const signIn = await flow.signInByDirectory(person.email, subject(), {
        client,
      });
      expect(signIn.mail).toBeDefined();
      expect((await connectionOf(person.email)).newAddress).toBe(false);
    });

    test("a send that fails signs nobody up to anything: the row shows nothing and holds no limit", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const failing = createMagicLinkRequests({
        auth: fixture.auth,
        db: fixture.db,
        environment: fixture.environment,
        transport: {
          send: async () => ({
            status: "failed",
            httpStatus: 422,
            errorCode: 406,
            retried: false,
          }),
        },
      });
      const browser = "f".repeat(43);
      const identity = {
        organizationId: of.id,
        providerId: of.row!.id,
        providerRevision: of.row!.revision,
        email: person.email,
        issuer: fixture.issuer.origin,
        subject: subject(),
        directoryUserId: subject(),
      };
      const errors = console.error;
      console.error = () => {};
      try {
        expect(
          await failing.connectDirectory({
            identity,
            browser,
            client: "198.18.201.4",
            pendingQuery: null,
          }),
        ).toBe("reserved");
        await failing.drain();
      } finally {
        console.error = errors;
      }
      const row = await connectionOf(person.email);
      expect(row.sendStatus).toBe("failed");
      expect(row.postmarkErrorCode).toBe(406);
      expect(
        await (
          await flow.openConnection(`answerable-sign-in=${browser}`)
        ).text(),
      ).toContain("No code is waiting");
      // It holds no limit, so the person can go through the directory again at once.
      expect(
        await fixture.mail.requests.connectDirectory({
          identity,
          browser,
          client: "198.18.201.4",
          pendingQuery: null,
        }),
      ).toBe("reserved");
    });

    test("a queue with no room marks the row failed, since no send will ever run", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const full = createMagicLinkRequests({
        auth: fixture.auth,
        db: fixture.db,
        environment: fixture.environment,
        transport: fixture.mail.transport,
        queue: { maxLength: 0, concurrency: 1 },
      });
      const errors = console.error;
      console.error = () => {};
      try {
        expect(
          await full.connectDirectory({
            identity: {
              organizationId: of.id,
              providerId: of.row!.id,
              providerRevision: of.row!.revision,
              email: person.email,
              issuer: fixture.issuer.origin,
              subject: subject(),
              directoryUserId: subject(),
            },
            browser: "q".repeat(43),
            client: "198.18.201.5",
            pendingQuery: null,
          }),
        ).toBe("reserved");
      } finally {
        console.error = errors;
      }
      expect((await connectionOf(person.email)).sendStatus).toBe("failed");
    });

    test("the job finds the address no longer connectable and asks nothing", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, person.memberId));
      expect(
        await fixture.mail.requests.connectDirectory({
          identity: {
            organizationId: of.id,
            providerId: of.row!.id,
            providerRevision: of.row!.revision,
            email: person.email,
            issuer: fixture.issuer.origin,
            subject: subject(),
            directoryUserId: subject(),
          },
          browser: "c".repeat(43),
          client: "198.18.201.6",
          pendingQuery: null,
        }),
      ).toBe("conflict");
      expect(await flow.requestsOf(person.email)).toEqual([]);
    });
  });
});

describe("the second proof: the right code in the same browser", () => {
  test("adds the account to the same user, writes identity.linked, keeps the magic-link account, makes no session, and goes to the directory", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const link = await askLink(person.email, {
      headers: { "cf-connecting-ip": "198.18.202.1" },
    });
    const byLink = flow.signedIn(await flow.follow(link.token!, link.cookie));
    const sessionsBefore = await flow.sessionsOf(person.userId);
    expect(sessionsBefore).toHaveLength(1);

    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub);
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    const row = await connectionOf(person.email);
    const entered = await flow.enterConnectionCode(signIn.code!, signIn.cookie);
    expect(entered.status).toBe(303);
    const directory = new URL(entered.headers.get("location")!);
    expect(directory.origin).toBe(fixture.issuer.origin);
    expect(directory.searchParams.get("login_hint")).toBe(person.email);

    // Connected, and still no session from it.
    expect(await flow.sessionsOf(person.userId)).toEqual(sessionsBefore);
    expect(entered.headers.getSetCookie().join()).not.toContain(
      "session_token",
    );
    const held = await flow.accountsOf(person.userId);
    expect(held).toHaveLength(2);
    const account = held.find((item) => item.issuer !== magicLinkIssuer)!;
    expect(account).toMatchObject({
      issuer: fixture.issuer.origin,
      accountId: sub,
      providerId: of.row!.providerId,
      directoryUserId: sub,
      directoryId: null,
      deletedAt: null,
    });
    expect(held.find((item) => item.issuer === magicLinkIssuer)).toBeDefined();
    const [event] = await linkedEvents(account.id);
    expect(event).toMatchObject({
      actorType: "user",
      organizationId: of.id,
      targetType: "account",
      outcome: "success",
    });
    expect(event!.requestId).toBeString();
    expect(event!.data).toEqual({
      magicLinkRequestId: row.id,
      authenticationProviderId: of.row!.id,
      authenticationProviderRevision: of.row!.revision,
      upstreamAuthTime: null,
    });
    // The attempt a right code counted is taken back, for the budgets, and the row is over.
    const [ended] = await flow
      .requestsOf(person.email)
      .then((rows) => rows.filter((item) => item.id === row.id));
    expect(ended!.attempts).toBe(0);
    expect(ended!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    // The ordinary path makes the session: this firm's directory row, one user, both ways live.
    const { response, cookie } = await flow.throughDirectory(
      entered,
      { sub, email: person.email, name: "Person" },
      { cookie: signIn.cookie },
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(cookie).toContain("session_token");
    const after = await flow.sessionsOf(person.userId);
    expect(after).toHaveLength(2);
    const made = after.find((item) => item.id !== sessionsBefore[0]!.id)!;
    expect(made.authenticationProviderId).toBe(of.row!.id);
    expect(made.authenticationAccountId).toBe(account.id);
    expect(made.upstreamAuthTime).not.toBeNull();
    expect(
      await fixture.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, person.email)),
    ).toHaveLength(1);
    // The session by link still stands.
    expect(
      await tenantAuthentication(fixture.db, {
        userId: person.userId,
        sessionId: sessionsBefore[0]!.id,
        organizationId: of.id,
      }),
    ).not.toBeNull();
    expect(byLink).toContain("session_token");
  });

  test("it works with links off, and turning links off strands nobody who connected", async () => {
    const of = await firm();
    await setLinks(of, false);
    const person = await waiting(of);
    const { response, cookie } = await finish(person);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(cookie).toContain("session_token");
    expect(await flow.accountsOf(person.userId)).toHaveLength(1);
  });

  test("a person a directory's first sign-in would have refused, imported through the real route, connects and keeps the `sub` import made", async () => {
    const of = await firm();
    const email = `imported-${createId()}@${of.domain}`;
    const headers = fixture.headers("platformAdmin");
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", createId());
    const imported = await fixture.app.request(
      `/api/admin/v1/organizations/${of.id}/members/import`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ addresses: [email] }),
      },
    );
    expect(imported.status).toBe(200);
    const [{ id }] = (await fixture.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))) as [{ id: string }];
    const sub = subject();
    const signIn = await flow.signInByDirectory(email, sub);
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    const { cookie } = await finish({ ...signIn, email, sub });
    expect(cookie).toContain("session_token");
    const [account] = await flow.accountsOf(id);
    expect(account!.accountId).toBe(sub);
    expect((await flow.sessionsOf(id))[0]!.userId).toBe(id);
  });

  test("a person a link made in domain mode connects too, and one user and one `sub` come of both ways", async () => {
    const of = await firm();
    await flow.allowClient(of.id);
    await flow.openToDomain(of);
    const email = `first-${createId()}@${of.domain}`;
    const link = await askLink(email, {
      headers: { "cf-connecting-ip": "198.18.202.2" },
    });
    expect(link.mail).toBeDefined();
    const byLink = flow.signedIn(await flow.follow(link.token!, link.cookie));
    const [{ id: userId }] = (await fixture.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))) as [{ id: string }];
    const [{ id: memberId }] = (await fixture.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, userId))) as [{ id: string }];

    const sub = subject();
    const signIn = await flow.signInByDirectory(email, sub);
    const { cookie: byDirectory } = await finish({ ...signIn, email, sub });

    const claims = async (session: string) =>
      decodeJwt(
        (
          (await flow.issueTokens(session, memberId)) as unknown as {
            access_token: string;
          }
        ).access_token,
      );
    const [viaLink, viaDirectory] = [
      await claims(byLink),
      await claims(byDirectory),
    ];
    expect(viaLink.sub).toBe(userId);
    expect(viaDirectory.sub).toBe(userId);
    expect(viaLink.authentication_method).toBe("magic_link");
    expect(viaDirectory.authentication_method).toBe("directory");
    expect(
      await fixture.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email)),
    ).toHaveLength(1);
    expect(await flow.accountsOf(userId)).toHaveLength(2);
  });

  test("the same person's directory session has the authority their magic-link session does not", async () => {
    const { organizationId } = fixture.tenant;
    const person = await flow.listed({
      id: organizationId,
      domain: "tenant.example.com",
    });
    await fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId,
      memberId: person.memberId,
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
    });
    const link = await askLink(person.email, {
      headers: { "cf-connecting-ip": "198.18.202.3" },
    });
    const byLink = flow.signedIn(await flow.follow(link.token!, link.cookie));
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub);
    const { cookie: byDirectory } = await finish({ ...signIn, ...person, sub });
    const read = (session: string) =>
      fixture.app.request(`/api/admin/v1/organizations/${organizationId}`, {
        headers: { cookie: session, origin: fixture.trustedOrigin },
      });
    expect((await read(byLink)).status).toBe(404);
    expect((await read(byDirectory)).status).toBe(200);
  });

  test("the platform organisation has no exception: its people connect, since a directory sign-in still makes the session", async () => {
    const platform = fixture.platform;
    const [{ domain }] = (await fixture.db
      .select({ domain: organizationDomains.domain })
      .from(organizationDomains)
      .where(
        eq(organizationDomains.organizationId, platform.organizationId),
      )) as [{ domain: string }];
    const person = await flow.listed({
      id: platform.organizationId,
      domain,
    });
    const [{ enabled, providerId, revision, id: directoryId }] =
      (await fixture.db
        .select()
        .from(ssoProviders)
        .where(
          and(
            eq(ssoProviders.organizationId, platform.organizationId),
            eq(ssoProviders.kind, "oidc"),
          ),
        )) as [typeof ssoProviders.$inferSelect];
    expect(enabled).toBe(true);
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub);
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    const row = await connectionOf(person.email);
    expect(row.providerId).toBe(directoryId);
    expect(row.providerRevision).toBe(revision);
    const { response, cookie } = await finish({ ...signIn, ...person, sub });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(cookie).toContain("session_token");
    const [account] = await flow.accountsOf(person.userId);
    expect(account!.providerId).toBe(providerId);
    // Mail alone still signs no one in there.
    const [session] = await flow.sessionsOf(person.userId);
    expect(session!.authenticationProviderId).toBe(directoryId);
  });

  test("an Entra directory's object id and tenant reach the account, as a first sign-in writes them", async () => {
    const tenantId = "22222222-2222-4222-8222-222222222222";
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const of = await firm(false);
    await createSsoProvider(fixture.db, {
      ...flow.directoryInput(of.slug),
      issuer,
      organizationId: of.id,
      providerId: of.slug,
    });
    const person = await flow.listed(of);
    const sub = subject();
    const entra = { iss: issuer, tid: tenantId, oid: "entra-object" };
    const signIn = await flow.signInByDirectory(person.email, sub, {
      claims: entra,
    });
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    expect(await connectionOf(person.email)).toMatchObject({
      directoryIssuer: issuer,
      directorySubject: sub,
      directoryUserId: "entra-object",
    });
    const entered = await flow.enterConnectionCode(signIn.code!, signIn.cookie);
    expect(entered.status).toBe(303);
    const [account] = await flow.accountsOf(person.userId);
    expect(account).toMatchObject({
      issuer,
      accountId: sub,
      directoryUserId: "entra-object",
      directoryId: tenantId,
    });
    const { response, cookie } = await flow.throughDirectory(
      entered,
      { sub, email: person.email, name: "Person", ...entra },
      { cookie: signIn.cookie },
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(cookie).toContain("session_token");
  });

  test("a Google directory's hosted domain reaches the account", async () => {
    const issuer = "https://accounts.google.com";
    const of = await firm(false);
    await createSsoProvider(fixture.db, {
      ...flow.directoryInput(of.slug),
      issuer,
      organizationId: of.id,
      providerId: of.slug,
    });
    const person = await flow.listed(of);
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub, {
      claims: { iss: issuer, hd: of.domain },
    });
    expect(
      (await flow.enterConnectionCode(signIn.code!, signIn.cookie)).status,
    ).toBe(303);
    const [account] = await flow.accountsOf(person.userId);
    expect(account).toMatchObject({
      directoryId: of.domain,
      directoryUserId: sub,
    });
  });

  describe("wrong, late and replayed", () => {
    test("a wrong code counts, answers alike, and leaves the right one working", async () => {
      const of = await firm();
      const person = await waiting(of);
      const answer = await flow.enterConnectionCode(
        wrong(person.code!),
        person.cookie,
      );
      expect(answer.status).toBe(200);
      const text = await answer.text();
      expect(text).toContain("That code didn&#39;t work");
      expect(text).toContain('action="/connect-directory"');
      expect(text).not.toContain(person.email);
      expect((await connectionOf(person.email)).attempts).toBe(1);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(303);
      expect(await flow.accountsOf(person.userId)).toHaveLength(1);
      expect((await connectionOf(person.email)).attempts).toBe(1);
    });

    test("three wrong codes end it: one audit row, and the right code then does nothing", async () => {
      const of = await firm();
      const person = await waiting(of);
      for (let attempt = 0; attempt < 3; attempt++)
        await flow.enterConnectionCode(wrong(person.code!), person.cookie);
      const row = await connectionOf(person.email);
      expect(row.attempts).toBe(3);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(
        await flow.refusals("auth.magic_link.code_exhausted", row.id),
      ).toHaveLength(1);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      expect(await (await flow.openConnection(person.cookie)).text()).toContain(
        "No code is waiting",
      );
    });

    test("a spent budget blocks the right code too, and wrong codes on either page count towards it", async () => {
      const of = await firm();
      const client = "198.18.203.1";
      const person = await flow.listed(of);
      const signIn = await flow.signInByDirectory(person.email, subject(), {
        client,
      });
      // Earlier wrong guesses by this client at a link's code: the budget adds up both.
      const linker = await flow.listed(of);
      const link = await askLink(linker.email, {
        headers: { "cf-connecting-ip": client },
      });
      const [linkRow] = await flow.requestsOf(linker.email);
      await fixture.db
        .update(magicLinkRequests)
        .set({ attempts: magicLinkCodeBudgets.clientPerHour })
        .where(eq(magicLinkRequests.id, linkRow!.id));
      expect(link.mail).toBeDefined();
      const logged: string[] = [];
      const { error } = console;
      console.error = (...args: unknown[]) => void logged.push(args.join(" "));
      let answer: Response;
      try {
        answer = await flow.enterConnectionCode(signIn.code!, signIn.cookie, {
          "cf-connecting-ip": client,
        });
      } finally {
        console.error = error;
      }
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain("That code didn&#39;t work");
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      expect(logged.join()).toContain("magic_link_code_budget_exhausted");
      // And the other way: wrong codes here are what a link's code page then sees.
      const [row] = await flow.requestsOf(person.email);
      await fixture.db
        .update(magicLinkRequests)
        .set({ attempts: 0 })
        .where(eq(magicLinkRequests.id, linkRow!.id));
      await fixture.db
        .update(magicLinkRequests)
        .set({ attempts: magicLinkCodeBudgets.clientPerHour })
        .where(eq(magicLinkRequests.id, row!.id));
      const blocked = await flow.enter(link.code!, link.cookie, {
        "cf-connecting-ip": client,
      });
      expect(blocked.status).toBe(200);
      expect(await flow.sessionsOf(linker.userId)).toEqual([]);
    });

    test("a firm's spent budget blocks it as well", async () => {
      const of = await firm();
      const person = await waiting(of);
      const [row] = await flow.requestsOf(person.email);
      const stranger = await flow.listed(of);
      const asked = await askLink(stranger.email);
      await fixture.db
        .update(magicLinkRequests)
        .set({ attempts: magicLinkCodeBudgets.organizationPerHour })
        .where(eq(magicLinkRequests.email, stranger.email));
      expect(asked.mail).toBeDefined();
      const { error } = console;
      console.error = () => {};
      try {
        expect(
          (await flow.enterConnectionCode(person.code!, person.cookie)).status,
        ).toBe(200);
      } finally {
        console.error = error;
      }
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      expect(row!.attempts).toBe(0);
    });

    test("another browser's cookie finds nothing, counts nothing and connects nothing", async () => {
      const of = await firm();
      const person = await waiting(of);
      const elsewhere = `answerable-sign-in=${"e".repeat(43)}`;
      const answer = await flow.enterConnectionCode(person.code!, elsewhere);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain("That code didn&#39;t work");
      expect((await connectionOf(person.email)).attempts).toBe(0);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      for (const cookie of ["", "answerable-sign-in=short"])
        expect(
          await (await flow.enterConnectionCode(person.code!, cookie)).text(),
        ).toContain("That code didn&#39;t work");
      expect((await connectionOf(person.email)).attempts).toBe(0);
    });

    test("not a code costs nothing, a cross-site post is refused, and over the budget it answers alike", async () => {
      const of = await firm();
      const person = await waiting(of);
      for (const code of ["1234567", "123456789", "abcdefgh", ""])
        expect(
          (await flow.enterConnectionCode(code, person.cookie)).status,
        ).toBe(200);
      expect((await connectionOf(person.email)).attempts).toBe(0);
      for (const headers of [
        { origin: "https://evil.example" },
        { "sec-fetch-site": "cross-site" },
      ]) {
        const refused = await flow.enterConnectionCode(
          person.code!,
          person.cookie,
          headers,
        );
        expect(refused.status).toBe(403);
      }
      expect((await connectionOf(person.email)).attempts).toBe(0);
      const client = { "cf-connecting-ip": "198.18.203.2" };
      for (let post = 0; post < 60; post++)
        await flow.enterConnectionCode("abc", person.cookie, client);
      const over = await flow.enterConnectionCode(
        person.code!,
        person.cookie,
        client,
      );
      expect(over.status).toBe(200);
      expect(await over.text()).toContain("That code didn&#39;t work");
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("past ten minutes the page shows nothing and the code does nothing", async () => {
      const of = await firm();
      const person = await waiting(of);
      await fixture.db
        .update(magicLinkRequests)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(magicLinkRequests.email, person.email));
      expect(await (await flow.openConnection(person.cookie)).text()).toContain(
        "No code is waiting",
      );
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("the page waits on this purpose alone, and not on a row that has spent its attempts", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const link = await askLink(person.email);
      expect(await (await flow.openConnection(link.cookie)).text()).toContain(
        "No code is waiting",
      );
      const other = await waiting(of);
      await fixture.db
        .update(magicLinkRequests)
        .set({ attempts: 3 })
        .where(eq(magicLinkRequests.email, other.email));
      expect(await (await flow.openConnection(other.cookie)).text()).toContain(
        "No code is waiting",
      );
    });

    test("a row that has not been sent cannot be answered, though the page shows it", async () => {
      const of = await firm();
      const person = await waiting(of);
      await fixture.db
        .update(magicLinkRequests)
        .set({ sendStatus: "sending" })
        .where(eq(magicLinkRequests.email, person.email));
      expect(await (await flow.openConnection(person.cookie)).text()).toContain(
        person.email,
      );
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("a used code is a refused code: no second account, no second event", async () => {
      const of = await firm();
      const person = await waiting(of);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(303);
      const [account] = await flow.accountsOf(person.userId);
      const replay = await flow.enterConnectionCode(
        person.code!,
        person.cookie,
      );
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain("That code didn&#39;t work");
      expect(await flow.accountsOf(person.userId)).toHaveLength(1);
      expect(await linkedEvents(account!.id)).toHaveLength(1);
      expect(await (await flow.openConnection(person.cookie)).text()).toContain(
        "No code is waiting",
      );
    });

    test("two requests from one browser each have their own code and identity, and the newest is shown", async () => {
      const of = await firm();
      const first = await flow.listed(of);
      const second = await flow.listed(of);
      const a = await flow.signInByDirectory(first.email, subject());
      const b = await flow.signInByDirectory(second.email, subject(), {
        cookie: a.cookie,
      });
      expect(await (await flow.openConnection(b.cookie)).text()).toContain(
        second.email,
      );
      expect((await flow.enterConnectionCode(a.code!, b.cookie)).status).toBe(
        303,
      );
      expect(await flow.accountsOf(first.userId)).toHaveLength(1);
      expect(await flow.accountsOf(second.userId)).toEqual([]);
    });
  });

  describe("purposes never cross", () => {
    test("a mailbox code on the link's page signs nobody in, and a link's code on this page links nothing, with both live in one browser", async () => {
      const of = await firm();
      const person = await flow.listed(of);
      const link = await askLink(person.email, {
        headers: { "cf-connecting-ip": "198.18.204.1" },
      });
      const signIn = await flow.signInByDirectory(person.email, subject(), {
        cookie: link.cookie,
        client: "198.18.204.2",
      });
      expect(signIn.code).toBeDefined();
      expect(signIn.code).not.toBe(link.code);

      const onLinkPage = await flow.enter(signIn.code!, signIn.cookie);
      expect(onLinkPage.status).toBe(200);
      expect(await onLinkPage.text()).toContain("That code didn&#39;t work");
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
      expect(await flow.accountsOf(person.userId)).toEqual([]);

      const onThisPage = await flow.enterConnectionCode(
        link.code!,
        signIn.cookie,
      );
      expect(onThisPage.status).toBe(200);
      expect(await onThisPage.text()).toContain("That code didn&#39;t work");
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
      expect(await flow.accountsOf(person.userId)).toEqual([]);

      // Each counted a wrong guess only against its own purpose, and each code still works.
      const rows = await flow.requestsOf(person.email);
      expect(rows.map((row) => [row.purpose, row.attempts]).sort()).toEqual([
        ["connect_directory", 1],
        ["link", 1],
      ]);
      expect(
        (await flow.enterConnectionCode(signIn.code!, signIn.cookie)).status,
      ).toBe(303);
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
      expect(await flow.accountsOf(person.userId)).toHaveLength(1);
      flow.signedIn(await flow.enter(link.code!, signIn.cookie));
      expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
      expect(await flow.accountsOf(person.userId)).toHaveLength(2);
    });

    test("a connection's row has no token: no page of a link's finds it", async () => {
      const of = await firm();
      const person = await waiting(of);
      for (const answer of [
        await flow.open("x".repeat(32), person.cookie),
        await flow.follow("x".repeat(32), person.cookie),
      ])
        expect(await answer.text()).toContain("This link can");
      expect((await connectionOf(person.email)).tokenIdentifier).toBeNull();
    });
  });

  describe("what can change in the ten minutes refuses, ends the row and writes one audit row", () => {
    const changes: Record<
      string,
      {
        reason: string;
        change: (of: Firm, person: Waiting) => Promise<unknown>;
      }
    > = {
      "the member removed": {
        reason: "not_connectable",
        change: (of, person) =>
          inTenant(fixture.db, of.id, (context) =>
            memberService.remove(context, person.memberId),
          ),
      },
      "the membership ended": {
        reason: "not_connectable",
        change: (_, person) =>
          fixture.db
            .update(members)
            .set({
              validFrom: new Date(Date.now() - 7_200_000),
              validUntil: new Date(Date.now() - 1_000),
            })
            .where(eq(members.id, person.memberId)),
      },
      "the user disabled": {
        reason: "not_connectable",
        change: (_, person) =>
          inPlatformUsers(fixture.db, (context) =>
            disableUser(context, person.userId),
          ),
      },
      "another account made in the meantime": {
        reason: "not_connectable",
        change: (of, person) =>
          fixture.db.insert(accounts).values({
            id: createId(),
            userId: person.userId,
            issuer: fixture.issuer.origin,
            providerId: of.row!.providerId,
            accountId: subject(),
          }),
      },
      "the directory changed": {
        reason: "directory_changed",
        change: (of) =>
          inPlatformWrite(fixture.db, (context) =>
            putSsoProvider(context, of.id, {
              ...flow.directoryInput(of.slug),
              domain: `changed.${of.domain}`,
            }),
          ),
      },
      "the directory removed": {
        reason: "directory_changed",
        change: (of) =>
          inPlatformWrite(fixture.db, (context) =>
            deleteSsoProvider(context, of.id),
          ),
      },
      "the domain disabled": {
        reason: "not_connectable",
        change: async (of) => {
          const [row] = await fixture.db
            .select({ id: organizationDomains.id })
            .from(organizationDomains)
            .where(eq(organizationDomains.domain, of.domain));
          await inPlatformWrite(fixture.db, (context) =>
            disableDomain(context, of.id, row!.id),
          );
        },
      },
      "the domain removed": {
        reason: "not_connectable",
        change: async (of) => {
          const [row] = await fixture.db
            .select({ id: organizationDomains.id })
            .from(organizationDomains)
            .where(eq(organizationDomains.domain, of.domain));
          await inPlatformWrite(fixture.db, (context) =>
            deleteOrganizationDomain(context, of.id, row!.id),
          );
        },
      },
      "the organisation disabled": {
        reason: "not_connectable",
        change: (of) =>
          inPlatformWrite(fixture.db, (context) =>
            disableOrganization(context, of.id),
          ),
      },
      "the subject taken by another account": {
        reason: "identity_taken",
        change: async (of, person) => {
          const other = await flow.listed(of);
          await fixture.db.insert(accounts).values({
            id: createId(),
            userId: other.userId,
            issuer: fixture.issuer.origin,
            providerId: of.row!.providerId,
            accountId: person.sub,
          });
        },
      },
      "the directory's user id taken by another account": {
        reason: "identity_taken",
        change: async (of, person) => {
          const other = await flow.listed(of);
          await fixture.db.insert(accounts).values({
            id: createId(),
            userId: other.userId,
            issuer: fixture.issuer.origin,
            providerId: of.row!.providerId,
            accountId: subject(),
            directoryUserId: person.sub,
          });
        },
      },
    };
    for (const [name, { reason, change }] of Object.entries(changes))
      test(`${name}: ${reason}`, async () => {
        const of = await firm();
        const person = await waiting(of);
        const row = await connectionOf(person.email);
        await change(of, person);
        const before = await flow.accountsOf(person.userId);
        const answer = await flow.enterConnectionCode(
          person.code!,
          person.cookie,
        );
        expect(answer.status).toBe(200);
        expect(await answer.text()).toContain(
          "We couldn&#39;t connect your company sign-in",
        );
        expect(await flow.accountsOf(person.userId)).toEqual(before);
        expect(await flow.sessionsOf(person.userId)).toEqual([]);
        const [event, ...rest] = await refusalsOf(row.id);
        expect(rest).toEqual([]);
        expect(event).toMatchObject({
          outcome: "denied",
          reason,
          organizationId: of.id,
          targetId: person.userId,
          targetType: "user",
        });
        // It ended, so a second post writes no second row and does no more.
        const ended = await connectionOf(person.email);
        expect(ended.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(
          (await flow.enterConnectionCode(person.code!, person.cookie)).status,
        ).toBe(200);
        expect(await refusalsOf(row.id)).toHaveLength(1);
      });

    test("a request naming a row that is no directory, or none at all, refuses", async () => {
      for (const named of [
        (of: Firm) => ({
          providerId: of.magicLink.id,
          providerRevision: of.magicLink.revision,
        }),
        () => ({ providerId: createId() }),
      ]) {
        const of = await firm();
        const person = await waiting(of);
        const row = await connectionOf(person.email);
        await fixture.db
          .update(magicLinkRequests)
          .set(named(of))
          .where(eq(magicLinkRequests.id, row.id));
        const answer = await flow.enterConnectionCode(
          person.code!,
          person.cookie,
        );
        expect(await answer.text()).toContain(
          "We couldn&#39;t connect your company sign-in",
        );
        expect((await refusalsOf(row.id))[0]!.reason).toBe("directory_changed");
        expect(await flow.accountsOf(person.userId)).toEqual([]);
      }
    });

    test("the domain that counts is the address's own: another of the firm's domains does not stand in", async () => {
      const of = await firm();
      await createOrganizationDomain(fixture.db, {
        organizationId: of.id,
        domain: `second.${of.domain}`,
      });
      const person = await waiting(of);
      const row = await connectionOf(person.email);
      const [domain] = await fixture.db
        .select({ id: organizationDomains.id })
        .from(organizationDomains)
        .where(eq(organizationDomains.domain, of.domain));
      await inPlatformWrite(fixture.db, (context) =>
        deleteOrganizationDomain(context, of.id, domain!.id),
      );
      await flow.enterConnectionCode(person.code!, person.cookie);
      expect((await refusalsOf(row.id))[0]!.reason).toBe("not_connectable");
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("a domain that has moved to another firm is not this firm's", async () => {
      const of = await firm();
      const person = await waiting(of);
      const row = await connectionOf(person.email);
      const elsewhere = await firm();
      const [domain] = await fixture.db
        .select({ id: organizationDomains.id })
        .from(organizationDomains)
        .where(eq(organizationDomains.domain, of.domain));
      await inPlatformWrite(fixture.db, (context) =>
        deleteOrganizationDomain(context, of.id, domain!.id),
      );
      await createOrganizationDomain(fixture.db, {
        organizationId: elsewhere.id,
        domain: of.domain,
      });
      await flow.enterConnectionCode(person.code!, person.cookie);
      expect((await refusalsOf(row.id))[0]!.reason).toBe("not_connectable");
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("a directory changed and changed back is still not the revision the request named", async () => {
      const of = await firm();
      const person = await waiting(of);
      const row = await connectionOf(person.email);
      const original = flow.directoryInput(of.slug);
      for (const domain of [`changed.${of.domain}`, original.domain])
        await inPlatformWrite(fixture.db, (context) =>
          putSsoProvider(context, of.id, { ...original, domain }),
        );
      const [directory] = await fixture.db
        .select({
          revision: ssoProviders.revision,
          domain: ssoProviders.domain,
        })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, of.row!.id));
      expect(directory!.domain).toBe(original.domain);
      expect(directory!.revision).toBeGreaterThan(row.providerRevision);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
      expect((await refusalsOf(row.id))[0]!.reason).toBe("directory_changed");
    });

    test("retiring the holder takes the row with it, so the next person at the address is not connected by the old code", async () => {
      const of = await firm();
      const person = await waiting(of);
      await inPlatformUsers(fixture.db, (context) =>
        disableUser(context, person.userId),
      );
      await inPlatformUsers(fixture.db, (context) =>
        retireUserEmail(context, person.userId),
      );
      expect(await flow.requestsOf(person.email)).toEqual([]);
      const next = await flow.listed(of, person.email.split("@")[0]);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
      expect(await flow.accountsOf(next.userId)).toEqual([]);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
    });

    test("erasing the person takes the row with them, and the code does nothing", async () => {
      const of = await firm();
      const person = await waiting(of);
      await inPlatformWrite(fixture.db, (context) =>
        eraseUser(context, person.userId, person.userId),
      );
      expect(await flow.requestsOf(person.email)).toEqual([]);
      expect(
        (await flow.enterConnectionCode(person.code!, person.cookie)).status,
      ).toBe(200);
    });

    test("a failure that is no refusal is not recorded as one", async () => {
      const of = await firm();
      const person = await waiting(of);
      const { connectDirectoryAccount } =
        await import("./directory-connection.ts");
      const row = await connectionOf(person.email);
      await expect(
        connectDirectoryAccount(
          new Proxy(fixture.db, {
            get() {
              throw new Error("Database unavailable");
            },
          }),
          row,
          { requestId: null, ip: null, userAgent: null },
        ),
      ).rejects.toThrow("Database unavailable");
    });
  });
});

describe("the pending authorisation", () => {
  async function authorizing(of: Firm) {
    await flow.allowClient(of.id);
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      {},
    );
    const login = new URL(started.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    return login.search.slice(1);
  }

  test("it survives the directory, the code and the directory again, through to a code at the end", async () => {
    const of = await firm();
    const query = await authorizing(of);
    const person = await flow.listed(of);
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub, { query });
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    const row = await connectionOf(person.email);
    expect(row.pendingOauthQuery).toBe(query);
    // Its way back keeps the place too.
    expect(await (await flow.openConnection(signIn.cookie)).text()).toContain(
      `href="/login?${query.replaceAll("&", "&amp;")}"`,
    );

    const entered = await flow.enterConnectionCode(signIn.code!, signIn.cookie);
    const { response, cookie } = await flow.throughDirectory(
      entered,
      { sub, email: person.email, name: "Person" },
      { cookie: signIn.cookie },
    );
    const selection = new URL(response.headers.get("location")!);
    expect(selection.pathname).toBe("/authorize");
    expect(selection.searchParams.get("client_id")).toBe(
      flow.authorizationQuery().get("client_id"),
    );
    const tokens = (await flow.finishAuthorization(
      selection.search.slice(1),
      cookie,
      person.memberId,
    )) as unknown as { access_token: string; refresh_token: string };
    expect(decodeJwt(tokens.access_token).sub).toBe(person.userId);
    expect(decodeJwt(tokens.access_token).authentication_method).toBe(
      "directory",
    );
    expect((await flow.refresh(tokens.refresh_token)).status).toBe(200);
  });

  test("a query that is signed and past the bound is not kept, and the person still connects", async () => {
    const of = await firm();
    await flow.allowClient(of.id);
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery({ state: "s".repeat(maxPendingQueryLength) })}`,
      {},
    );
    const query = new URL(started.headers.get("location")!).search.slice(1);
    expect(query.length).toBeGreaterThan(maxPendingQueryLength);
    const person = await flow.listed(of);
    const signIn = await flow.signInByDirectory(person.email, subject(), {
      query,
    });
    expect(signIn.response.headers.get("location")).toBe("/connect-directory");
    expect((await connectionOf(person.email)).pendingOauthQuery).toBeNull();
    expect(await (await flow.openConnection(signIn.cookie)).text()).toContain(
      'href="/login"',
    );
  });

  test("a query written into a sign-in's error address by hand is not kept unless it verifies", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    fixture.issuer.enqueue({
      sub: subject(),
      email: person.email,
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000),
    });
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: of.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
      errorCallbackURL: `${fixture.trustedOrigin}/error?client_id=evil&sig=forged`,
    });
    expect(signedIn.location).toBe("/connect-directory");
    expect((await connectionOf(person.email)).pendingOauthQuery).toBeNull();
  });

  test("a query that has expired by the right code is left out, and the sign-in lands on /login", async () => {
    const of = await firm();
    const query = await authorizing(of);
    const person = await flow.listed(of);
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub, { query });
    // The signature no longer verifies, as one past its `exp` does not.
    await fixture.db
      .update(magicLinkRequests)
      .set({ pendingOauthQuery: `${query}&expired=1` })
      .where(eq(magicLinkRequests.email, person.email));
    const entered = await flow.enterConnectionCode(signIn.code!, signIn.cookie);
    expect(entered.status).toBe(303);
    const { response, cookie } = await flow.throughDirectory(
      entered,
      { sub, email: person.email, name: "Person" },
      { cookie: signIn.cookie },
    );
    expect(response.headers.get("location")).toBe(
      `${fixture.environment.betterAuthUrl}/login`,
    );
    expect(cookie).toContain("session_token");
  });

  test("should the directory not start, the account stays connected and the page says where to go, with the query", async () => {
    const of = await firm();
    const query = await authorizing(of);
    const person = await flow.listed(of);
    const signIn = await flow.signInByDirectory(person.email, subject(), {
      query,
    });
    const failing = (
      handler: (request: Request) => Promise<Response>,
    ): AdminFixture["auth"] => ({ ...fixture.auth, handler });
    const asked: Record<string, string>[] = [];
    const app = createApp({
      auth: failing(async (request) => {
        asked.push(await request.json());
        return new Response(null, { status: 503 });
      }),
      db: fixture.db,
      environment: fixture.environment,
    });
    const answer = await app.request("/connect-directory", {
      method: "POST",
      headers: {
        origin: fixture.environment.betterAuthUrl,
        "content-type": "application/x-www-form-urlencoded",
        cookie: signIn.cookie,
        "cf-connecting-ip": "198.18.205.1",
      },
      body: new URLSearchParams({ code: signIn.code! }),
    });
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(text).toContain("Your company sign-in is connected");
    expect(text).toContain('href="/login?');
    // What it asked of sign-in: this firm, this person, and the place in the application,
    // kept wherever the sign-in lands, whether it works or not.
    const { origin } = new URL(fixture.environment.betterAuthUrl);
    expect(asked).toEqual([
      {
        organizationSlug: of.slug,
        loginHint: person.email,
        callbackURL: `${origin}/login?${query}`,
        errorCallbackURL: `${origin}/error?${query}&firm=${of.slug}`,
        oauth_query: query,
      },
    ]);
    expect(await flow.accountsOf(person.userId)).toHaveLength(1);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);

    // A throw, with no query to keep, answers the same.
    const other = await flow.listed(of);
    const again = await flow.signInByDirectory(other.email, subject());
    const logged: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    let thrown: Response;
    try {
      thrown = await createApp({
        auth: failing(() => Promise.reject(new Error("unavailable"))),
        db: fixture.db,
        environment: fixture.environment,
      }).request("/connect-directory", {
        method: "POST",
        headers: {
          origin: fixture.environment.betterAuthUrl,
          "content-type": "application/x-www-form-urlencoded",
          cookie: again.cookie,
          "cf-connecting-ip": "198.18.205.2",
        },
        body: new URLSearchParams({ code: again.code! }),
      });
    } finally {
      console.error = error;
    }
    const plain = await thrown.text();
    expect(plain).toContain("Your company sign-in is connected");
    expect(plain).toContain('href="/login"');
    expect(logged.join()).toContain("page_auth_call_failed");
  });
});

describe("a magic link added after a directory", () => {
  test("through the real choice page: the same user and `sub`, and each method's sessions and grants end on their own", async () => {
    const of = await firm();
    await flow.allowClient(of.id);
    const person = await flow.directorySignIn(
      of,
      { providerId: of.slug },
      `both-${createId()}`,
    );
    const directoryTokens = (await flow.issueTokens(
      person.cookie,
      person.memberId,
    )) as unknown as { access_token: string; refresh_token: string };

    // The page offers both, and choosing the link answers the check-email page.
    const choice = await flow.post("/login", { email: person.email });
    expect(choice.status).toBe(200);
    const page = await choice.text();
    expect(page).toContain("Email me a sign-in link");
    const before = fixture.mail.transport.sent.length;
    const chosen = await flow.post("/login", {
      email: person.email,
      method: "link",
    });
    expect(await chosen.text()).toContain("Check your email");
    await fixture.mail.settled();
    const mail = fixture.mail.transport.sent
      .slice(before)
      .find((message) => message.to === person.email)!;
    const code = codeIn(mail)!;
    const cookie = cookiesAfter("", chosen.headers.getSetCookie());
    const byLink = flow.signedIn(await flow.enter(code, cookie));
    const held = await flow.accountsOf(person.userId);
    expect(held).toHaveLength(2);
    const linked = held.find((item) => item.issuer === magicLinkIssuer)!;
    expect(await linkedEvents(linked.id)).toHaveLength(1);

    const linkTokens = (await flow.issueTokens(
      byLink,
      person.memberId,
    )) as unknown as { access_token: string; refresh_token: string };
    expect(decodeJwt(linkTokens.access_token).sub).toBe(person.userId);
    expect(decodeJwt(directoryTokens.access_token).sub).toBe(person.userId);
    expect(decodeJwt(linkTokens.access_token).authentication_method).toBe(
      "magic_link",
    );
    expect(
      await fixture.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, person.email)),
    ).toHaveLength(1);

    const stand = async (provider: string) => {
      const rows = await fixture.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, person.userId),
            eq(sessions.authenticationProviderId, provider),
          ),
        );
      return tenantAuthentication(fixture.db, {
        userId: person.userId,
        sessionId: rows[0]!.id,
        organizationId: of.id,
      });
    };
    // Changing the directory ends the directory's and leaves the link's.
    await inPlatformWrite(fixture.db, (context) =>
      putSsoProvider(context, of.id, {
        ...flow.directoryInput(of.slug),
        domain: `changed.${of.domain}`,
      }),
    );
    expect(await stand(of.row!.id)).toBeNull();
    expect(await stand(of.magicLink.id)).not.toBeNull();
    expect((await flow.refresh(directoryTokens.refresh_token)).status).not.toBe(
      200,
    );
    const renewed = await flow.refresh(linkTokens.refresh_token);
    expect(renewed.status).toBe(200);

    // Turning links off ends the link's, and a new directory sign-in stands.
    await inPlatformWrite(fixture.db, (context) =>
      disableMagicLink(context, of.id),
    );
    expect(await stand(of.magicLink.id)).toBeNull();
    const { refresh_token: next } = (await renewed.json()) as {
      refresh_token: string;
    };
    expect((await flow.refresh(next)).status).not.toBe(200);
  });
});

describe("two firms", () => {
  test("a person in both connects at the firm whose directory they used, and only there", async () => {
    const mine = await firm();
    const theirs = await firm();
    const person = await flow.listed(mine);
    await fixture.db.insert(members).values({
      id: createId(),
      organizationId: theirs.id,
      userId: person.userId,
    });
    const sub = subject();
    const signIn = await flow.signInByDirectory(person.email, sub);
    const row = await connectionOf(person.email);
    expect(row.organizationId).toBe(mine.id);
    expect(row.providerId).toBe(mine.row!.id);
    await finish({ ...signIn, ...person, sub });
    const [account] = await flow.accountsOf(person.userId);
    expect(account!.providerId).toBe(mine.row!.providerId);
    // Its other firm's directory cannot now connect a different subject to this user.
    const domain = `second-${createId()}.example.com`;
    await createOrganizationDomain(fixture.db, {
      organizationId: theirs.id,
      domain,
    });
    await fixture.db
      .update(users)
      .set({ email: `${person.userId}@${domain}` })
      .where(eq(users.id, person.userId));
    const other = await flow.signInByDirectory(
      `${person.userId}@${domain}`,
      subject(),
    );
    expect(errorOf(other.response)).toBe("email_conflict");
  });

  test("a membership at another firm does not rescue a person removed from this one", async () => {
    const mine = await firm();
    const theirs = await firm();
    const person = await waiting(mine);
    await fixture.db.insert(members).values({
      id: createId(),
      organizationId: theirs.id,
      userId: person.userId,
    });
    const row = await connectionOf(person.email);
    await inTenant(fixture.db, mine.id, (context) =>
      memberService.remove(context, person.memberId),
    );
    await flow.enterConnectionCode(person.code!, person.cookie);
    expect((await refusalsOf(row.id))[0]!.reason).toBe("not_connectable");
    expect(await flow.accountsOf(person.userId)).toEqual([]);
  });
});

describe("the row's shape", () => {
  async function shapes() {
    const of = await firm();
    const base = {
      organizationId: of.id,
      providerId: of.row!.id,
      providerRevision: of.row!.revision,
      email: `shape-${createId()}@${of.domain}`,
      clientHash: "client",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const identity = {
      directoryIssuer: "https://issuer.example",
      directorySubject: "subject",
      directoryUserId: "subject",
    };
    const secrets = { browserHash: "browser", codeHmac: "code" };
    return { base, identity, secrets };
  }
  const insert = async (values: typeof magicLinkRequests.$inferInsert) => {
    await fixture.db.insert(magicLinkRequests).values(values);
  };
  const violates = (values: typeof magicLinkRequests.$inferInsert) =>
    expect(insert(values)).rejects.toMatchObject({
      cause: { constraint: "magic_link_requests_purpose_fields_check" },
    });

  test("a connection has a browser, a code and the whole identity, no token, and is never a new address", async () => {
    const { base, identity, secrets } = await shapes();
    const row = {
      ...base,
      ...identity,
      ...secrets,
      purpose: "connect_directory" as const,
    };
    await insert({ ...row, id: createId() });
    await insert({ ...row, id: createId(), pendingOauthQuery: "query" });
    for (const change of [
      { browserHash: null },
      { codeHmac: null },
      { directoryIssuer: null },
      { directorySubject: null },
      { directoryUserId: null },
      { tokenIdentifier: `magic-link:${createId()}` },
      { newAddress: true },
    ])
      await violates({ ...row, ...change, id: createId() });
  });

  test("no other purpose may hold an identity", async () => {
    const { base, identity, secrets } = await shapes();
    for (const [name, value] of Object.entries(identity)) {
      await violates({
        ...base,
        ...secrets,
        id: createId(),
        purpose: "link",
        tokenIdentifier: `magic-link:${createId()}`,
        [name]: value,
      });
      await violates({
        ...base,
        id: createId(),
        purpose: "access_removed",
        [name]: value,
      });
    }
  });

  test("a purpose outside the vocabulary is refused", async () => {
    const { base, identity, secrets } = await shapes();
    await expect(
      insert({
        ...base,
        ...identity,
        ...secrets,
        id: createId(),
        purpose: "other" as "link",
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "magic_link_requests_purpose_check" },
    });
  });
});

test("the page's post takes a small body, as the other sign-in forms do", async () => {
  const of = await firm();
  const person = await waiting(of);
  const answer = await flow.post(
    "/connect-directory",
    { code: person.code!, padding: "x".repeat(4 * 1024) },
    { cookie: person.cookie },
  );
  expect(answer.status).toBe(413);
  expect(await flow.accountsOf(person.userId)).toEqual([]);
});

describe("a broken database", () => {
  const unreachable = () =>
    createApp({
      auth: fixture.auth,
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("Database unavailable");
          },
        },
      ) as AdminFixture["db"],
      environment: fixture.environment,
    });

  test("the page and the post answer as they answer nothing, and say so to operators", async () => {
    const cookie = `answerable-sign-in=${"d".repeat(43)}`;
    const logged: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const app = unreachable();
      expect(
        await (
          await app.request("/connect-directory", { headers: { cookie } })
        ).text(),
      ).toContain("No code is waiting");
      expect(
        await (
          await app.request("/connect-directory", {
            method: "POST",
            headers: {
              cookie,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ code: "12345678" }),
          })
        ).text(),
      ).toContain("That code didn&#39;t work");
    } finally {
      console.error = error;
    }
    expect(
      logged.filter((line) => line.includes("page_auth_call_failed")),
    ).toHaveLength(2);
  });
});

test("erasure and retirement release this purpose's rows, and diagnosis reads them", async () => {
  const of = await firm();
  const person = await waiting(of);
  const row = await connectionOf(person.email);
  const diagnosed = await fixture.app.request(
    `/api/admin/v1/organizations/${of.id}/sign-in-diagnosis?email=${encodeURIComponent(person.email)}`,
    { headers: fixture.headers("platformAdmin") },
  );
  expect(diagnosed.status).toBe(200);
  const body = (await diagnosed.json()) as {
    magicLink: {
      lastRequest: { id: string; purpose: string };
      directoryConnection: { id: string; sendStatus: string } | null;
    };
  };
  expect(body.magicLink.lastRequest).toMatchObject({
    id: row.id,
    purpose: "connect_directory",
  });
  expect(body.magicLink.directoryConnection).toMatchObject({
    id: row.id,
    sendStatus: "sent",
  });
  await inPlatformUsers(fixture.db, (context) =>
    disableUser(context, person.userId),
  );
  await inPlatformUsers(fixture.db, (context) =>
    retireUserEmail(context, person.userId),
  );
  expect(await flow.requestsOf(person.email)).toEqual([]);
  expect(
    await fixture.db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.id, row.id)),
  ).toEqual([]);
});

test("setting the firm to domain mode, or turning links off, changes nothing about who may connect", async () => {
  const of = await firm();
  await flow.openToDomain(of);
  await inPlatformWrite(fixture.db, (context) =>
    setMagicLinkAdmission(context, of.id, "listed"),
  );
  await inPlatformWrite(fixture.db, (context) =>
    disableMagicLink(context, of.id),
  );
  const person = await waiting(of);
  expect((await connectionOf(person.email)).providerId).toBe(of.row!.id);
  // Not a member, in a firm in any mode, is still refused.
  const userId = createId();
  const email = `not-member-${userId}@${of.domain}`;
  await fixture.db.insert(users).values({
    id: userId,
    name: "Not a member",
    email,
    emailVerified: true,
    status: "active",
  });
  expect(
    errorOf((await flow.signInByDirectory(email, subject())).response),
  ).toBe("email_conflict");
});
