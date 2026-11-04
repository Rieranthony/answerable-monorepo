import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { answerOf, magicLinkFlow } from "../../__tests__/magic-link-flow.ts";
import { createApp } from "../../__tests__/app.ts";
import { magicLinkIdentifier } from "../../auth/magic-link.ts";
import {
  magicLinkRequests,
  members,
  organizationDomains,
  ssoProviders,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { maxPendingQueryLength } from "./login-routing.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  // A pool of one: nothing a sign-in does may need a second connection.
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
});
afterAll(() => fixture?.close());

const fixedId = { "x-request-id": "fixed-request" };
let nextFirm = 0;
const firm = (directory = false) =>
  flow.seedOrganization(`pages-${++nextFirm}`, directory);

describe("POST /login routes by the domain's firm", () => {
  test("links on and no directory: the check-email page and one email", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { response, mail, token, code } = await flow.ask(email);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Check your email");
    expect(text).toContain(email);
    expect(text).toContain('action="/magic-link/code?"');
    expect(text).toContain('autocomplete="one-time-code"');
    expect(mail!.to).toBe(email);
    expect(token).toMatch(/^[A-Za-z]{32}$/);
    expect(code).toMatch(/^\d{8}$/);
  });

  test("a live directory with links off goes to the directory and sends no mail", async () => {
    const organization = await firm(true);
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, organization.magicLink.id));
    const { email } = await flow.listed(organization);
    const sent = fixture.mail.transport.sent.length;
    const { response, setCookies } = await flow.ask(email);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/authorize",
    );
    expect(setCookies.join()).not.toContain("answerable-sign-in");
    expect(fixture.mail.transport.sent).toHaveLength(sent);
    expect(await flow.requestsOf(email)).toEqual([]);
  });

  test("links off and no directory, and an unknown domain, answer as they did", async () => {
    const off = await firm();
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, off.magicLink.id));
    const { email } = await flow.listed(off);
    const sent = fixture.mail.transport.sent.length;
    for (const address of [email, `person@unknown-${createId()}.example.com`]) {
      const { response, setCookies } = await flow.ask(address);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('role="alert"');
      expect(text).toContain("Work email");
      expect(text).not.toContain("Check your email");
      expect(setCookies).toEqual([]);
    }
    expect(fixture.mail.transport.sent).toHaveLength(sent);
    const unknown = await flow.ask(`person@unknown-${createId()}.example.com`);
    expect(await unknown.response.text()).toContain(
      "We couldn&#39;t find your organisation",
    );
  });

  test("a disabled domain and a disabled firm answer as an unknown one", async () => {
    const disabled = await firm();
    const { email } = await flow.listed(disabled);
    await fixture.db
      .update(organizationDomains)
      .set({ status: "disabled" })
      .where(eq(organizationDomains.domain, disabled.domain));
    const { response } = await flow.ask(email);
    expect(await response.text()).toContain(
      "We couldn&#39;t find your organisation",
    );
    expect(await flow.requestsOf(email)).toEqual([]);
  });

  test("the address's own refusals are all one page, byte for byte, apart from the address", async () => {
    const organization = await firm();
    const admitted = await flow.listed(organization, "uniform-admitted");
    const removed = await flow.listed(organization, "uniform-removed");
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, removed.memberId));
    const disabled = await flow.listed(organization, "uniform-disabled");
    await fixture.db
      .update(users)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(users.id, disabled.userId));
    const limited = await flow.listed(organization, "uniform-limited");
    const client = { "cf-connecting-ip": "198.51.100.30" };
    await flow.ask(limited.email, { headers: { ...fixedId, ...client } });
    const stranger = `uniform-stranger@${organization.domain}`;
    // An address the pattern passes and the one parser refuses.
    const unparsed = `"uniform"@${organization.domain}`;
    const pages = [];
    for (const email of [
      admitted.email,
      removed.email,
      disabled.email,
      limited.email,
      stranger,
      unparsed,
    ]) {
      const { response } = await flow.ask(email, {
        headers: { ...fixedId, ...client },
      });
      expect(response.status).toBe(200);
      pages.push(await answerOf(response, email.replaceAll('"', "&quot;")));
    }
    for (const page of pages) expect(page).toEqual(pages[0]!);
    // What differs is what the job did, after the response.
    expect(
      fixture.mail.transport.sent.filter((m) => m.to === stranger),
    ).toEqual([]);
    expect(await flow.requestsOf(limited.email)).toHaveLength(1);
  });

  test("a full queue says so, whatever the address, and gives the browser nothing to wait on", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const stranger = `queue-stranger@${organization.domain}`;
    const full = createApp({
      auth: fixture.auth,
      db: fixture.db,
      environment: fixture.environment,
      magicLinks: {
        request: () => false,
        connectDirectory: fixture.mail.requests.connectDirectory,
      },
    });
    const form = (address: string) => ({
      method: "POST",
      headers: {
        ...fixedId,
        origin: fixture.environment.betterAuthUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ email: address }),
    });
    const [listed, unknown] = [
      await full.request("/login", form(email)),
      await full.request("/login", form(stranger)),
    ];
    expect(listed.status).toBe(503);
    expect(listed.headers.get("retry-after")).toBe("60");
    expect(listed.headers.getSetCookie()).toEqual([]);
    const [first, second] = [
      await answerOf(listed, email),
      await answerOf(unknown, stranger),
    ];
    expect(first).toEqual(second);
    expect(first.body).toContain("We can&#39;t send email just now");
    expect(first.body).toContain("Try again in a minute.");
    expect(first.body).not.toContain("Check your email");
    expect(await flow.requestsOf(email)).toEqual([]);
  });

  test("the page says what to do when nothing arrives", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { response } = await flow.ask(email);
    const text = await response.text();
    expect(text).toContain("check your junk or quarantine folder");
    expect(text).toContain("You can ask again after a minute");
    // The bare address, as an IT team types it into an allow list.
    expect(text).toContain("allow email from sign-in@id.example.com.");
  });

  test("a request the queue takes for an address nobody can have costs nothing, and the page is the usual one", async () => {
    const organization = await firm();
    const unparsed = `"queued"@${organization.domain}`;
    const { response } = await flow.ask(unparsed);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Check your email");
  });

  test("a reload keeps the browser's value and renews it, so the first link still works", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const first = await flow.ask(email);
    const value = first.cookie.split("=")[1]!;
    expect(first.setCookies[0]).toContain("Max-Age=1800");
    const second = await flow.ask(email, {
      cookie: first.cookie,
      headers: { "cf-connecting-ip": "198.51.100.40" },
    });
    expect(second.setCookies[0]).toContain(`=${value};`);
    expect(second.setCookies[0]).toContain("Max-Age=1800");
    const page = await flow.open(first.token!, first.cookie);
    expect(await page.text()).toContain(`Continue as ${email}`);
  });

  test("a malformed cookie is replaced, and the job binds to the new value", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { cookie, setCookies, token } = await flow.ask(email, {
      cookie: "answerable-sign-in=nonsense",
    });
    expect(setCookies[0]).not.toContain("nonsense");
    const page = await flow.open(token!, cookie);
    expect(await page.text()).toContain("Continue as");
  });
});

describe("the client's budget", () => {
  test("three hundred in ten seconds pass, and the next is a 429 page that queues nothing", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const client = { "cf-connecting-ip": "198.51.100.61" };
    let last: Response | undefined;
    let queued = 0;
    const counted = createApp({
      auth: fixture.auth,
      db: fixture.db,
      environment: fixture.environment,
      magicLinks: {
        request: () => {
          queued++;
          return true;
        },
        connectDirectory: fixture.mail.requests.connectDirectory,
      },
    });
    for (let index = 0; index < 301; index++)
      last = await counted.request("/login", {
        method: "POST",
        headers: {
          ...client,
          origin: fixture.environment.betterAuthUrl,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ email }),
      });
    expect(queued).toBe(300);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toBe("10");
    expect(last!.headers.getSetCookie()).toEqual([]);
    const text = await last!.text();
    expect(text).toContain("Too many sign-in attempts");
    expect(text).not.toContain(email);
    // Its own, and it depends on no address: another client is untouched.
    const other = await counted.request("/login", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "198.51.100.62",
        origin: fixture.environment.betterAuthUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ email }),
    });
    expect(other.status).toBe(200);
  });

  test("requests that name no client share one count", async () => {
    const counted = createApp({
      auth: fixture.auth,
      db: fixture.db,
      environment: fixture.environment,
    });
    let status = 0;
    for (let index = 0; index < 301; index++)
      status = (
        await counted.request("/login", {
          method: "POST",
          headers: {
            origin: fixture.environment.betterAuthUrl,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ email: "not-an-address" }),
        })
      ).status;
    expect(status).toBe(429);
  });

  test("a cross-site post spends nothing of it", async () => {
    const counted = createApp({
      auth: fixture.auth,
      db: fixture.db,
      environment: fixture.environment,
    });
    const send = (origin: string) =>
      counted.request("/login", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.51.100.63",
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ email: "not-an-address" }),
      });
    for (let index = 0; index < 310; index++)
      expect((await send("https://evil.example")).status).toBe(403);
    expect((await send(fixture.environment.betterAuthUrl)).status).toBe(200);
  });
});

describe("?organization=<slug>", () => {
  test("a firm with links on and no directory shows the form with no error", async () => {
    const organization = await firm();
    const response = await fixture.app.request(
      `/login?organization=${organization.slug}`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Work email");
    expect(text).not.toContain('role="alert"');
  });

  test("a firm with only a directory starts its sign-in, and one with neither says so", async () => {
    const directory = await firm(true);
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, directory.magicLink.id));
    expect(
      (await fixture.app.request(`/login?organization=${directory.slug}`))
        .status,
    ).toBe(302);
    const off = await firm();
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, off.magicLink.id));
    expect(
      await (
        await fixture.app.request(`/login?organization=${off.slug}`)
      ).text(),
    ).toContain('role="alert"');
    expect(
      await (await fixture.app.request(`/login?organization=nobody`)).text(),
    ).toContain('role="alert"');
  });
});

describe("the pending query", () => {
  test("a validly signed query past the bound is dropped too, and one inside it kept", async () => {
    await flow.registerClient();
    const organization = await firm();
    const signed = async (state: string) => {
      const started = await flow.protocol(
        `/oauth2/authorize?${flow.authorizationQuery({ state })}`,
        {},
      );
      return new URL(started.headers.get("location")!).search.slice(1);
    };
    const long = await signed("s".repeat(maxPendingQueryLength));
    expect(long.length).toBeGreaterThan(maxPendingQueryLength);
    const past = await flow.listed(organization);
    const dropped = await flow.ask(past.email, { query: long });
    expect(dropped.mail).toBeDefined();
    expect(
      (await flow.requestsOf(past.email))[0]!.pendingOauthQuery,
    ).toBeNull();

    const short = await signed("short");
    const within = await flow.listed(organization);
    await flow.ask(within.email, { query: short });
    expect((await flow.requestsOf(within.email))[0]!.pendingOauthQuery).toBe(
      short,
    );
  });

  test("a query that is not signed, or is past the bound, is dropped and the sign-in goes on", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization, "unsigned");
    const unsigned = await flow.ask(email, {
      query: "client_id=a&sig=not-a-signature",
    });
    expect(unsigned.mail).toBeDefined();
    const long = await flow.listed(organization, "too-long");
    const past = await flow.ask(long.email, {
      query: `client_id=a&sig=b&state=${"s".repeat(maxPendingQueryLength)}`,
    });
    expect(past.mail).toBeDefined();
    for (const address of [email, long.email])
      expect((await flow.requestsOf(address))[0]!.pendingOauthQuery).toBeNull();
    // The page keeps the person's place in the URL it was given, for "ask for a new link".
    expect(await unsigned.response.text()).toContain(
      'action="/magic-link/code?client_id=a&amp;sig=not-a-signature"',
    );
  });
});

describe("GET and HEAD /magic-link", () => {
  test("a scanner fetches at any count, with no cookie and with one, and consumes nothing", async () => {
    const organization = await firm();
    const { email, userId } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const [before] = await flow.requestsOf(email);
    for (let index = 0; index < 10; index++)
      for (const method of ["GET", "HEAD"])
        for (const headers of [
          {} as Record<string, string>,
          { cookie },
          { "user-agent": "SafeLinks" },
        ])
          expect(
            (
              await fixture.app.request(`/magic-link?token=${token}`, {
                method,
                headers,
              })
            ).status,
          ).toBe(200);
    expect(await flow.requestsOf(email)).toEqual([before!]);
    expect(await flow.tokenRows(before!.tokenIdentifier!)).toHaveLength(1);
    expect(await flow.sessionsOf(userId)).toEqual([]);
    expect(await flow.accountsOf(userId)).toEqual([]);
    // It still works.
    flow.signedIn(await flow.follow(token!, cookie));
  });

  test("HEAD answers as GET does, with no body", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const head = await fixture.app.request(`/magic-link?token=${token}`, {
      method: "HEAD",
      headers: { cookie },
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
  });

  test("the browser that asked sees the address and a form holding the token", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const text = await (await flow.open(token!, cookie)).text();
    expect(text).toContain(`Continue as ${email}`);
    expect(text).toContain('action="/magic-link"');
    expect(text).toContain(`name="token" value="${token}"`);
  });

  test("another browser, unknown, used and expired answer one page that names nobody", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization, "elsewhere");
    const asked = await flow.ask(email);
    const other = await flow.ask(
      (await flow.listed(organization, "elsewhere-other")).email,
    );
    const used = await flow.listed(organization, "elsewhere-used");
    const spent = await flow.ask(used.email);
    flow.signedIn(await flow.follow(spent.token!, spent.cookie));
    const old = await flow.listed(organization, "elsewhere-old");
    const expired = await flow.ask(old.email);
    await fixture.db
      .update(magicLinkRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(magicLinkRequests.email, old.email));

    const get = (token: string, cookie = "") =>
      Promise.resolve(
        fixture.app.request(`/magic-link?token=${token}`, {
          headers: { ...fixedId, ...(cookie ? { cookie } : {}) },
        }),
      ).then((response) => answerOf(response));
    const answers = [
      await get(asked.token!),
      await get(asked.token!, other.cookie),
      await get("unknownunknownunknownunknownunkn", asked.cookie),
      await get(spent.token!, spent.cookie),
      await get(expired.token!, expired.cookie),
      await get("", asked.cookie),
      await get("a".repeat(129), asked.cookie),
    ];
    for (const answer of answers) expect(answer).toEqual(answers[0]!);
    expect(answers[0]!.status).toBe(200);
    const page = answers[0]!.body;
    expect(page).toContain("This link can&#39;t sign you in here");
    expect(page).toContain('href="/login"');
    expect(page).not.toContain("@");
  });

  test("a request with no token at all is that page too, and a database failure reads alike", async () => {
    const unreachable = createApp({
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
    const logged: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      for (const path of ["/magic-link", "/magic-link?token=abc"]) {
        const response = await unreachable.request(path, {
          headers: { cookie: `answerable-sign-in=${"a".repeat(43)}` },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("This link can");
      }
      const posted = await unreachable.request("/magic-link", {
        method: "POST",
        headers: {
          cookie: `answerable-sign-in=${"a".repeat(43)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: "abc" }),
      });
      expect(await posted.text()).toContain("This link can");
      const code = await unreachable.request("/magic-link/code", {
        method: "POST",
        headers: {
          cookie: `answerable-sign-in=${"a".repeat(43)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ code: "12345678" }),
      });
      expect(await code.text()).toContain("That code didn&#39;t work");
    } finally {
      console.error = error;
    }
    expect(
      logged.filter((line) => line.includes("page_auth_call_failed")),
    ).toHaveLength(3);
    expect(logged.join()).not.toContain("abc");
  });

  test("no cookie, or a token too long to be one, costs no database work", async () => {
    let touched = 0;
    const unreachable = createApp({
      auth: fixture.auth,
      db: new Proxy(
        {},
        {
          get() {
            touched++;
            throw new Error("Database unavailable");
          },
        },
      ) as AdminFixture["db"],
      environment: fixture.environment,
    });
    const cookie = `answerable-sign-in=${"a".repeat(43)}`;
    const form = (fields: Record<string, string>, held?: string) => ({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(held ? { cookie: held } : {}),
      },
      body: new URLSearchParams(fields),
    });
    const long = "a".repeat(129);
    const logged: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      for (const [path, init] of [
        ["/magic-link?token=abc", {}],
        [`/magic-link?token=${long}`, { headers: { cookie } }],
        ["/magic-link", form({ token: "abc" })],
        ["/magic-link", form({ token: long }, cookie)],
        ["/magic-link/code", form({ code: "12345678" })],
      ] as const) {
        const response = await unreachable.request(path, init);
        expect(response.status, path).toBe(200);
      }
    } finally {
      console.error = error;
    }
    expect(touched).toBe(0);
    expect(logged).toEqual([]);
  });

  test("the pages have the page middleware: headers, no-store and the renderer", async () => {
    const paths: [string, RequestInit][] = [
      ["/magic-link?token=abc", {}],
      ["/magic-link?token=abc", { method: "HEAD" }],
      [
        "/magic-link",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "token=abc",
        },
      ],
      [
        "/magic-link/code",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "code=1",
        },
      ],
    ];
    for (const [path, init] of paths) {
      const response = await fixture.app.request(path, init);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      if (init.method !== "HEAD") {
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toStartWith("<!DOCTYPE html>");
      }
    }
  });

  test("the bodies these routes take are small", async () => {
    const big = "x".repeat(5 * 1024);
    for (const path of ["/magic-link", "/magic-link/code"]) {
      const response = await fixture.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${big}`,
      });
      expect(response.status).toBe(413);
    }
  });
});

describe("POST /magic-link", () => {
  test("the same browser signs in, and lands on /login with nothing to resume", async () => {
    const organization = await firm();
    const { email, userId } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const response = await flow.follow(token!, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("location")).not.toContain(token!);
    const session = flow.signedIn(response);
    expect(session).toContain("better-auth.session_token=");
    const page = await fixture.app.request("/login", {
      headers: { cookie: session },
    });
    expect(await page.text()).toContain(`Signed in as ${email}`);
    expect(await flow.sessionsOf(userId)).toHaveLength(1);
  });

  test("a form-filling scanner with no cookie and a token alone burn nothing and sign nobody in", async () => {
    const organization = await firm();
    const { email, userId } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const [row] = await flow.requestsOf(email);
    for (const held of [
      "",
      "answerable-sign-in=nonsense",
      `answerable-sign-in=${"b".repeat(43)}`,
    ]) {
      const response = await flow.follow(token!, held);
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.text()).toContain("This link can");
    }
    expect(await flow.sessionsOf(userId)).toEqual([]);
    expect(await flow.tokenRows(row!.tokenIdentifier!)).toHaveLength(1);
    expect(await flow.refusals("auth.magic_link.refused", row!.id)).toEqual([]);
    flow.signedIn(await flow.follow(token!, cookie));
  });

  test("replay, expiry and unknown answer identically on a post", async () => {
    const organization = await firm();
    const first = await flow.listed(organization);
    const replayed = await flow.ask(first.email);
    flow.signedIn(await flow.follow(replayed.token!, replayed.cookie));
    const second = await flow.listed(organization);
    const expired = await flow.ask(second.email);
    await fixture.db
      .update(magicLinkRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(magicLinkRequests.email, second.email));
    const answers = await Promise.all(
      [
        await flow.follow(replayed.token!, replayed.cookie, fixedId),
        await flow.follow(expired.token!, expired.cookie, fixedId),
        await flow.follow("unknown", replayed.cookie, fixedId),
        await flow.follow("", replayed.cookie, fixedId),
        await flow.follow("a".repeat(129), replayed.cookie, fixedId),
      ].map((response) => answerOf(response)),
    );
    for (const answer of answers) expect(answer).toEqual(answers[0]!);
    expect(answers[0]!.status).toBe(200);
  });
});

describe("POST /magic-link/code", () => {
  test("from a second browser's page, the code signs in only the browser that asked", async () => {
    const organization = await firm();
    const { email, userId } = await flow.listed(organization);
    const { code, cookie } = await flow.ask(email);
    const stranger = await flow.enter(
      code!,
      `answerable-sign-in=${"c".repeat(43)}`,
    );
    expect(stranger.status).toBe(200);
    expect(stranger.headers.getSetCookie()).toEqual([]);
    expect(await flow.sessionsOf(userId)).toEqual([]);
    expect((await flow.requestsOf(email))[0]!.attempts).toBe(0);
    flow.signedIn(await flow.enter(code!, cookie));
    expect(await flow.sessionsOf(userId)).toHaveLength(1);
  });

  test("one answer: no cookie, no row, not a code, wrong, ended and expired read alike", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { code, cookie } = await flow.ask(email);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    const strangerCookie = `answerable-sign-in=${"d".repeat(43)}`;
    const answers = [];
    for (const [value, held] of [
      [code!, ""],
      ["12345678", strangerCookie],
      ["123", cookie],
      ["abcdefgh", cookie],
      ["123456789", cookie],
      [wrong, cookie],
    ] as const) {
      answers.push(await answerOf(await flow.enter(value, held, fixedId)));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]!);
    expect(answers[0]!.status).toBe(200);
    expect(answers[0]!.body).toContain("That code didn&#39;t work");
    // Only the one well-formed guess at a real row counted.
    expect((await flow.requestsOf(email))[0]!.attempts).toBe(1);
    // A form with no code field at all.
    const empty = await flow.post("/magic-link/code", {}, { cookie });
    expect(await empty.text()).toContain("That code didn&#39;t work");
  });

  test("the query in the URL stays on the form and in the link to start again", async () => {
    const response = await flow.post(
      "/magic-link/code?client_id=a&sig=b",
      { code: "1" },
      {},
    );
    const text = await response.text();
    expect(text).toContain('action="/magic-link/code?client_id=a&amp;sig=b"');
    expect(text).toContain('href="/login?client_id=a&amp;sig=b"');
  });
});

describe("cross-site posts", () => {
  test("every shape is refused on all three routes before anything happens", async () => {
    const organization = await firm();
    const { email, userId } = await flow.listed(organization);
    const { token, code, cookie } = await flow.ask(email);
    const shapes: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "http://localhost:47301" },
      { origin: "", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "cross-site" },
      {
        origin: fixture.environment.betterAuthUrl,
        "sec-fetch-site": "cross-site",
      },
    ];
    const sent = fixture.mail.transport.sent.length;
    for (const headers of shapes) {
      for (const [path, fields] of [
        ["/login", { email }],
        ["/magic-link", { token: token! }],
        ["/magic-link/code", { code: code! }],
      ] as const) {
        const response = await fixture.app.request(path, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            ...headers,
          },
          body: new URLSearchParams(fields),
        });
        expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(response.headers.getSetCookie()).toEqual([]);
      }
    }
    await fixture.mail.settled();
    expect(fixture.mail.transport.sent).toHaveLength(sent);
    const [row] = await flow.requestsOf(email);
    expect(row!.attempts).toBe(0);
    expect(await flow.tokenRows(row!.tokenIdentifier!)).toHaveLength(1);
    expect(await flow.sessionsOf(userId)).toEqual([]);
  });

  test("a post with no Origin and no fetch metadata is not a cross-site browser, as on /login", async () => {
    const organization = await firm();
    const { email } = await flow.listed(organization);
    const { token, cookie } = await flow.ask(email);
    const response = await fixture.app.request("/magic-link", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: token! }),
    });
    expect(response.status).toBe(303);
  });
});

test("no address, token, code or hash reaches a log line, on any path", async () => {
  const organization = await firm();
  const { email } = await flow.listed(organization, "logged");
  const lines: string[] = [];
  const write = (...args: unknown[]) => void lines.push(args.join(" "));
  const { log, error, warn } = console;
  Object.assign(console, { log: write, error: write, warn: write });
  let secrets: string[] = [];
  try {
    const { token, code, cookie } = await flow.ask(email);
    await flow.open(token!, cookie);
    await flow.enter("00000000", cookie);
    await flow.follow(token!, cookie);
    await flow.ask(`stranger@${organization.domain}`);
    const [row] = await flow.requestsOf(email);
    secrets = [
      email,
      token!,
      code!,
      cookie.split("=")[1]!,
      row!.codeHmac!,
      row!.browserHash!,
      row!.clientHash,
      magicLinkIdentifier(token!),
      `stranger@${organization.domain}`,
    ];
  } finally {
    Object.assign(console, { log, error, warn });
  }
  expect(lines.length).toBeGreaterThan(0);
  const everything = lines.join("\n");
  for (const secret of secrets) expect(everything).not.toContain(secret);
});
