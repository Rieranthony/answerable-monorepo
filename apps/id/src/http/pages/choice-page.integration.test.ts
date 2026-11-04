import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { answerOf, magicLinkFlow } from "../../__tests__/magic-link-flow.ts";
import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import { createSsoProvider } from "../../__tests__/sso-queries.ts";
import { createApp } from "../../app.ts";
import { members, ssoProviders, users } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { deleteSsoProvider } from "../../services/sso-providers.ts";
import { maxPendingQueryLength } from "./login-routing.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
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
  flow.seedOrganization(`choice-${++nextFirm}`, directory);
type Firm = Awaited<ReturnType<typeof firm>>;

const linksOff = (of: Firm) =>
  fixture.db
    .update(ssoProviders)
    .set({ enabled: false })
    .where(eq(ssoProviders.id, of.magicLink.id));

const directoryAt = (of: Firm, issuer: string) =>
  createSsoProvider(fixture.db, {
    ...flow.directoryInput(of.slug),
    issuer,
    organizationId: of.id,
    providerId: of.slug,
  });

/** What an application sends and the login page it lands on: a signed query. */
async function signedQuery(of: Firm) {
  await flow.allowClient(of.id);
  const started = await flow.protocol(
    `/oauth2/authorize?${flow.authorizationQuery()}`,
    {},
  );
  return new URL(started.headers.get("location")!).search.slice(1);
}

describe("POST /login, a firm with both", () => {
  test("answers two ways and no redirect: it sets no cookie, sends no mail and writes no row", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const sent = fixture.mail.transport.sent.length;
    const { response, setCookies } = await flow.ask(person.email);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(setCookies).toEqual([]);
    const page = await response.text();
    expect(page).toContain("Choose how to sign in as");
    expect(page).toContain("Continue with company sign-in");
    expect(page).toContain("Email me a sign-in link");
    expect(page).toContain('name="method" value="directory"');
    expect(page).toContain('name="method" value="link"');
    // Each button carries the address, so neither asks for it again.
    expect(page.split(`name="email" value="${person.email}"`).length - 1).toBe(
      2,
    );
    expect(page).not.toContain("Work email");
    expect(page).not.toContain("<script");
    expect(page).toContain("Works with");
    expect(fixture.mail.transport.sent).toHaveLength(sent);
    expect(await flow.requestsOf(person.email)).toEqual([]);
  });

  test("names the directory from its issuer", async () => {
    for (const [issuer, label, logo] of [
      [
        "https://login.microsoftonline.com/33333333-3333-4333-8333-333333333333/v2.0",
        "Continue with Microsoft",
        true,
      ],
      ["https://accounts.google.com", "Continue with Google", true],
      ["https://idp.example.com", "Continue with company sign-in", false],
    ] as const) {
      const of = await firm(false);
      await directoryAt(of, issuer);
      const { response } = await flow.ask(`someone@${of.domain}`);
      const page = await response.text();
      expect(page).toContain(label);
      const button = page.slice(
        page.indexOf('value="directory"'),
        page.indexOf("Continue with"),
      );
      expect(button.includes("<svg")).toBe(logo);
    }
  });

  test("depends only on the domain: a member, a stranger, a removed member and a disabled person see one page, apart from the address", async () => {
    const of = await firm();
    const member = await flow.listed(of, "same-member");
    const removed = await flow.listed(of, "same-removed");
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, removed.memberId));
    const disabled = await flow.listed(of, "same-disabled");
    await fixture.db
      .update(users)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(users.id, disabled.userId));
    const fixed = {
      headers: {
        "x-request-id": "fixed",
        "cf-connecting-ip": "198.18.210.1",
      },
    };
    const pages = [];
    for (const email of [
      member.email,
      removed.email,
      disabled.email,
      `same-stranger@${of.domain}`,
    ]) {
      const { response } = await flow.ask(email, fixed);
      pages.push(await answerOf(response, email));
    }
    for (const page of pages) expect(page).toEqual(pages[0]!);
  });

  test("choosing the directory starts its sign-in with the address as a hint, and sends no mail", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const sent = fixture.mail.transport.sent.length;
    const response = await flow.post("/login", {
      email: person.email,
      method: "directory",
    });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin).toBe(fixture.issuer.origin);
    expect(url.searchParams.get("login_hint")).toBe(person.email);
    expect(fixture.mail.transport.sent).toHaveLength(sent);
  });

  test("choosing the link answers the same check-email page whatever the address's state", async () => {
    const of = await firm();
    const member = await flow.listed(of, "link-member");
    const removed = await flow.listed(of, "link-removed");
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, removed.memberId));
    const fixed = {
      headers: {
        "x-request-id": "fixed",
        "cf-connecting-ip": "198.18.210.2",
      },
      method: "link" as const,
    };
    const pages = [];
    for (const email of [
      member.email,
      removed.email,
      `link-stranger@${of.domain}`,
    ]) {
      const { response } = await flow.ask(email, fixed);
      expect(response.status).toBe(200);
      pages.push(await answerOf(response, email));
    }
    for (const page of pages) expect(page).toEqual(pages[0]!);
    expect(pages[0]!.body).toContain("Check your email");
    const { mail } = await flow.ask(member.email, {
      method: "link",
      headers: { "cf-connecting-ip": "198.18.210.3" },
    });
    expect(mail).toBeDefined();
  });

  test("a person blocked at the directory reaches a sign-in by the link, with no directory involved", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const asked = await flow.ask(person.email, { method: "link" });
    const cookie = flow.signedIn(await flow.follow(asked.token!, asked.cookie));
    const [session] = await flow.sessionsOf(person.userId);
    expect(session!.authenticationProviderId).toBe(of.magicLink.id);
    expect(cookie).toContain("session_token");
  });

  test("each button keeps the pending query, and a choice resumes on it", async () => {
    const of = await firm();
    const query = await signedQuery(of);
    const person = await flow.listed(of);
    const answer = await flow.post(`/login?${query}`, { email: person.email });
    const page = await answer.text();
    const action = `action="/login?${query.replaceAll("&", "&amp;")}"`;
    expect(page.split(action).length - 1).toBe(2);
    const asked = await flow.ask(person.email, { query, method: "link" });
    expect((await flow.requestsOf(person.email))[0]!.pendingOauthQuery).toBe(
      query,
    );
    const resumed = await flow.follow(asked.token!, asked.cookie);
    expect(resumed.status).toBe(303);
    expect(new URL(resumed.headers.get("location")!).pathname).toBe(
      "/authorize",
    );
  });

  test("the origin check and the client budget that guard the form guard each button", async () => {
    const of = await firm();
    const email = `budget@${of.domain}`;
    const sent = fixture.mail.transport.sent.length;
    for (const method of ["directory", "link"]) {
      const refused = await flow.post(
        "/login",
        { email, method },
        { headers: { origin: "https://evil.example" } },
      );
      expect(refused.status).toBe(403);
      expect(refused.headers.get("location")).toBeNull();
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    const counted = createApp({
      auth: fixture.auth,
      db: fixture.db,
      environment: fixture.environment,
    });
    const send = (method: string) =>
      counted.request("/login", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.18.210.4",
          origin: fixture.environment.betterAuthUrl,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ email, method }),
      });
    for (let post = 0; post < 60; post++) await send("");
    for (const method of ["directory", "link", ""]) {
      const over = await send(method);
      expect(over.status).toBe(429);
      expect(over.headers.get("location")).toBeNull();
    }
    expect(fixture.mail.transport.sent).toHaveLength(sent);
  });

  test("an answer from a stale page goes wherever the firm now sends it", async () => {
    // Links turned off since the page was drawn: the link's button goes to the directory.
    const off = await firm();
    await linksOff(off);
    const link = await flow.post("/login", {
      email: `stale@${off.domain}`,
      method: "link",
    });
    expect(link.status).toBe(302);
    expect(new URL(link.headers.get("location")!).origin).toBe(
      fixture.issuer.origin,
    );
    // The directory removed since: its button answers the check-email page.
    const gone = await firm(false);
    const directory = await flow.post("/login", {
      email: `stale@${gone.domain}`,
      method: "directory",
    });
    expect(await directory.text()).toContain("Check your email");
    // Anything else is no answer, and asks.
    const both = await firm();
    const odd = await flow.post("/login", {
      email: `odd@${both.domain}`,
      method: "something-else",
    });
    expect(await odd.text()).toContain("Choose how to sign in");
  });

  test("a directory that has been removed is not offered: its firm's links are the way in", async () => {
    const of = await firm();
    await inPlatformWrite(fixture.db, (context) =>
      deleteSsoProvider(context, of.id),
    );
    expect(
      await (await flow.post("/login", { email: `a@${of.domain}` })).text(),
    ).toContain("Check your email");
    const form = await (
      await fixture.app.request(`/login?organization=${of.slug}`)
    ).text();
    expect(form).toContain("Work email");
    expect(form).not.toContain("Continue with");
  });

  test("an address goes by its own domain, whatever firm the page's address names", async () => {
    const named = await firm();
    const mine = await firm();
    const response = await flow.post(`/login?organization=${named.slug}`, {
      email: `a@${mine.domain}`,
      method: "directory",
    });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(url.searchParams.get("login_hint")).toBe(`a@${mine.domain}`);
    expect(url.searchParams.get("client_id")).toBe(`${mine.slug}-client`);
  });

  test("a directory alone, a link alone and neither answer as they did", async () => {
    const onlyDirectory = await firm();
    await linksOff(onlyDirectory);
    const redirected = await flow.post("/login", {
      email: `a@${onlyDirectory.domain}`,
    });
    expect(redirected.status).toBe(302);
    const onlyLinks = await firm(false);
    expect(
      await (
        await flow.post("/login", { email: `a@${onlyLinks.domain}` })
      ).text(),
    ).toContain("Check your email");
    const neither = await firm(false);
    await linksOff(neither);
    expect(
      await (
        await flow.post("/login", { email: `a@${neither.domain}` })
      ).text(),
    ).toContain('role="alert"');
  });
});

describe("GET /login?organization=<slug>, a firm without both", () => {
  test("a directory alone starts it, and links alone ask for the address with nothing else to choose", async () => {
    const directory = await firm();
    await linksOff(directory);
    expect(
      (await fixture.app.request(`/login?organization=${directory.slug}`))
        .status,
    ).toBe(302);
    const links = await firm(false);
    const form = await fixture.app.request(`/login?organization=${links.slug}`);
    expect(form.status).toBe(200);
    const text = await form.text();
    expect(text).toContain("Work email");
    expect(text).not.toContain("Continue with");
    expect(text).not.toContain('role="alert"');
  });
});

describe("GET /login?organization=<slug>, a firm with both", () => {
  test("offers both and redirects nowhere, and the directory's button needs no address", async () => {
    const of = await firm();
    const page = await fixture.app.request(`/login?organization=${of.slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("location")).toBeNull();
    const text = await page.text();
    expect(text).toContain("Choose how to sign in.");
    expect(text).toContain("Continue with company sign-in");
    expect(text).toContain("Work email");
    expect(text).toContain("Email me a sign-in link");

    const started = await flow.post(`/login?organization=${of.slug}`, {
      method: "directory",
    });
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get("location")!).origin).toBe(
      fixture.issuer.origin,
    );

    const person = await flow.listed(of);
    const asked = await flow.ask(person.email, {
      query: `organization=${of.slug}`,
      method: "link",
    });
    expect(await asked.response.text()).toContain("Check your email");
    expect(asked.mail).toBeDefined();
  });

  test("a post with no address and no answer starts nothing", async () => {
    const of = await firm();
    const answer = await flow.post(`/login?organization=${of.slug}`, {});
    expect(answer.status).toBe(200);
    expect(answer.headers.get("location")).toBeNull();
    expect(await answer.text()).toContain('role="alert"');
  });

  test("a directory's failed start, or no address and no firm, keeps the form and says so", async () => {
    const { response } = await flow.ask("", {
      query: "organization=nobody-here",
    });
    expect(await response.text()).toContain('role="alert"');
    const started = await flow.post(`/login?organization=nobody-here`, {
      method: "directory",
    });
    expect(started.status).toBe(200);
    const text = await started.text();
    expect(text).toContain('role="alert"');
    expect(text).toContain("Work email");
    const noFirm = await flow.post("/login", { method: "directory" });
    expect(noFirm.status).toBe(200);
    expect(await noFirm.text()).toContain('role="alert"');
    const failing = createApp({
      auth: {
        ...fixture.auth,
        handler: () => Promise.reject(new Error("unavailable")),
      },
      db: fixture.db,
      environment: fixture.environment,
    });
    const of = await firm();
    const { error } = console;
    console.error = () => {};
    try {
      const thrown = await failing.request(`/login?organization=${of.slug}`, {
        method: "POST",
        headers: {
          origin: fixture.environment.betterAuthUrl,
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.18.210.5",
        },
        body: new URLSearchParams({ method: "directory" }),
      });
      expect(thrown.status).toBe(200);
      expect(await thrown.text()).toContain("We couldn&#39;t sign you in");
    } finally {
      console.error = error;
    }
  });

  test("a read that fails starts sign-in as it does for any firm", async () => {
    const of = await firm();
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
    const answer = await unreachable.request(`/login?organization=${of.slug}`);
    expect(answer.status).toBe(302);
    expect(new URL(answer.headers.get("location")!).origin).toBe(
      fixture.issuer.origin,
    );
  });

  test("a message from a failed sign-out is shown on the choice", async () => {
    const of = await firm();
    const failing = createApp({
      auth: {
        ...fixture.auth,
        handler: async (request: Request) =>
          new URL(request.url).pathname === "/auth/sign-out"
            ? new Response(null, { status: 503 })
            : fixture.auth.handler(request),
      },
      db: fixture.db,
      environment: fixture.environment,
    });
    const answer = await failing.request(`/sign-out?organization=${of.slug}`, {
      method: "POST",
      headers: {
        origin: fixture.environment.betterAuthUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({}),
    });
    const text = await answer.text();
    expect(text).toContain("We couldn&#39;t sign you out");
    expect(text).toContain("Continue with company sign-in");
  });
});

describe("the selection page", () => {
  async function selection(cookie: string) {
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      { cookie },
    );
    const url = new URL(started.headers.get("location")!);
    expect(url.pathname).toBe("/authorize");
    return url.search.slice(1);
  }
  const choose = (
    query: string,
    member: string,
    cookie: string,
    extra: Record<string, string> = {},
  ) =>
    fixture.app.request(`/authorize?${query}`, {
      method: "POST",
      headers: {
        cookie,
        origin: fixture.environment.betterAuthUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ member, ...extra }),
    });

  async function memberOfBoth(mine: Firm, theirs: Firm) {
    const person = await flow.directorySignIn(
      mine,
      undefined,
      `p-${createId()}`,
    );
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: theirs.id,
      userId: person.userId,
    });
    return { ...person, otherMemberId: memberId };
  }

  test("choosing a firm with both, unauthenticated there, offers the two ways; nothing redirects", async () => {
    const mine = await firm();
    const theirs = await firm();
    await flow.allowClient(mine.id);
    await flow.allowClient(theirs.id);
    const person = await memberOfBoth(mine, theirs);
    const query = await selection(person.cookie);
    const chosen = await choose(query, person.otherMemberId, person.cookie);
    expect(chosen.status).toBe(200);
    expect(chosen.headers.get("location")).toBeNull();
    const text = await chosen.text();
    expect(text).toContain("Continue with company sign-in");
    expect(text).toContain("Email me a sign-in link");
    expect(text).toContain("Work email");
    expect(text).toContain(`name="member" value="${person.otherMemberId}"`);
    const escaped = query.replaceAll("&", "&amp;");
    expect(text).toContain(`action="/authorize?${escaped}"`);
    expect(text).toContain(`action="/login?${escaped}"`);

    // The directory's button is the same post with the answer in it.
    const started = await choose(query, person.otherMemberId, person.cookie, {
      method: "directory",
    });
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get("location")!).origin).toBe(
      fixture.issuer.origin,
    );
  });

  test("a firm with only a directory starts it, and one with only links asks for the address", async () => {
    const mine = await firm();
    await flow.allowClient(mine.id);
    const directory = await firm();
    await linksOff(directory);
    await flow.allowClient(directory.id);
    const person = await memberOfBoth(mine, directory);
    const query = await selection(person.cookie);
    const started = await choose(query, person.otherMemberId, person.cookie);
    expect(started.status).toBe(302);

    const links = await firm(false);
    await flow.allowClient(links.id);
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: links.id,
      userId: person.userId,
    });
    const asked = await choose(query, memberId, person.cookie);
    expect(asked.status).toBe(200);
    const text = await asked.text();
    expect(text).toContain("Work email");
    expect(text).not.toContain("Continue with");
  });

  test("a firm with neither starts nothing and says so", async () => {
    const mine = await firm();
    await flow.allowClient(mine.id);
    const neither = await firm(false);
    await linksOff(neither);
    await flow.allowClient(neither.id);
    const person = await memberOfBoth(mine, neither);
    const query = await selection(person.cookie);
    const answer = await choose(query, person.otherMemberId, person.cookie);
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(text).toContain(
      "We couldn&#39;t start your organisation&#39;s sign-in",
    );
    expect(text).not.toContain("Work email");
  });

  test("an authenticated member goes straight on, whatever the firm offers", async () => {
    const mine = await firm();
    await flow.allowClient(mine.id);
    const person = await flow.directorySignIn(
      mine,
      undefined,
      `p-${createId()}`,
    );
    const query = await selection(person.cookie);
    const chosen = await choose(query, person.memberId, person.cookie);
    expect(chosen.status).toBe(302);
    expect(new URL(chosen.headers.get("location")!).pathname).toBe("/consent");
  });

  test("the words are true for each session: only a directory's offers to connect another account", async () => {
    const of = await firm();
    await flow.allowClient(of.id);
    const byDirectory = await flow.directorySignIn(
      of,
      undefined,
      `p-${createId()}`,
    );
    const page = async (cookie: string, query: string) =>
      (
        await fixture.app.request(`/authorize?${query}`, {
          headers: { cookie },
        })
      ).text();
    const directoryPage = await page(
      byDirectory.cookie,
      await selection(byDirectory.cookie),
    );
    expect(directoryPage).toContain(
      "Each organisation requires its own sign-in",
    );
    expect(directoryPage).not.toContain("company sign-in");
    expect(directoryPage).toContain("Connect another work account");

    const listed = await flow.listed(of);
    const asked = await flow.ask(listed.email, { method: "link" });
    const byLink = flow.signedIn(await flow.follow(asked.token!, asked.cookie));
    const linkPage = await page(byLink, await selection(byLink));
    expect(linkPage).toContain("Each organisation requires its own sign-in");
    expect(linkPage).not.toContain("company sign-in");
    expect(linkPage).not.toContain("Connect another work account");
  });
});

describe("the error page after a failed sign-in", () => {
  const refused = async (
    of: Firm,
    query = "",
    claims: Record<string, unknown> = {},
  ) => {
    const email = `refused-${createId()}@${of.domain}`;
    const { response } = await flow.signInByDirectory(
      email,
      `s-${createId()}`,
      {
        query,
        claims: { email_verified: false, ...claims },
      },
    );
    const location = response.headers.get("location")!;
    expect(new URL(location).pathname).toBe("/error");
    expect(new URL(location).searchParams.get("error")).toBe(
      "email_unverified",
    );
    return location;
  };

  test("a firm with links on is offered the link, and the post is W5's", async () => {
    const of = await firm();
    const location = await refused(of);
    expect(new URL(location).searchParams.get("firm")).toBe(of.slug);
    const url = new URL(location);
    const page = await fixture.app.request(url.pathname + url.search);
    const text = await page.text();
    expect(text).toContain("Verify your email address");
    expect(text).toContain("Email me a sign-in link");
    expect(text).toContain('name="method" value="link"');
    expect(text).toContain("Work email");
    expect(text).toContain('action="/login?"');
    expect(text).toContain('href="/login"');
    expect(text).not.toContain("Continue with");

    const person = await flow.listed(of);
    const asked = await flow.ask(person.email, { method: "link" });
    expect(await asked.response.text()).toContain("Check your email");
    expect(asked.mail).toBeDefined();
  });

  test("a firm with links off is offered no link, only the way back", async () => {
    const of = await firm();
    await linksOff(of);
    const location = await refused(of);
    const url = new URL(location);
    const text = await (
      await fixture.app.request(url.pathname + url.search)
    ).text();
    expect(text).toContain("Try another email");
    expect(text).not.toContain("Email me a sign-in link");
  });

  test("it carries the signed query, so that either way back keeps the application's place", async () => {
    const of = await firm();
    const query = await signedQuery(of);
    const location = await refused(of, query);
    const url = new URL(location);
    const text = await (
      await fixture.app.request(url.pathname + url.search)
    ).text();
    const escaped = query.replaceAll("&", "&amp;");
    expect(text).toContain(`action="/login?${escaped}"`);
    expect(text).toContain(`href="/login?${escaped}"`);
    expect(text).not.toContain("firm=");
    expect(text).not.toContain("email_unverified&amp;");
  });

  test("anyone can write this address, so nothing unsigned is kept, and a made-up firm is offered nothing", async () => {
    const of = await firm();
    const query = await signedQuery(of);
    const forged = new URLSearchParams(query);
    forged.set("redirect_uri", "https://evil.example");
    for (const search of [
      forged.toString(),
      "client_id=evil&sig=forged",
      `${query}&redirect_uri=https%3A%2F%2Fevil.example`,
    ]) {
      const text = await (await fixture.app.request(`/error?${search}`)).text();
      expect(text).toContain('href="/login"');
      expect(text).not.toContain("evil");
    }
    const long = new URLSearchParams(query);
    long.set("state", "s".repeat(maxPendingQueryLength));
    expect(
      await (await fixture.app.request(`/error?${long}`)).text(),
    ).toContain('href="/login"');

    for (const name of [
      "nobody-here",
      "UPPER",
      "../../etc",
      "<script>",
      "a".repeat(1000),
      "",
    ]) {
      const answer = await fixture.app.request(
        `/error?error=email_conflict&firm=${encodeURIComponent(name)}`,
      );
      expect(answer.status).toBe(200);
      const text = await answer.text();
      expect(text).not.toContain("Email me a sign-in link");
      expect(text).not.toContain(name || "firm=");
    }
    // A firm named by hand is told only what its domain's sign-in tells anyone: it offers links.
    expect(
      await (await fixture.app.request(`/error?firm=${of.slug}`)).text(),
    ).toContain("Email me a sign-in link");
  });

  test("a name that cannot be a firm's costs no database work", async () => {
    let touched = 0;
    const counting = createApp({
      auth: fixture.auth,
      db: new Proxy(fixture.db, {
        get(target, name, receiver) {
          touched++;
          return Reflect.get(target, name, receiver);
        },
      }),
      environment: fixture.environment,
    });
    const of = await firm();
    const answer = await counting.request(
      `/error?firm=${encodeURIComponent("Not A Slug!")}`,
    );
    expect(answer.status).toBe(200);
    expect(touched).toBe(0);
    await counting.request(`/error?firm=${of.slug}`);
    expect(touched).toBeGreaterThan(0);
  });

  test("a read that fails leaves the way back", async () => {
    const of = await firm();
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
    const answer = await unreachable.request(`/error?firm=${of.slug}`);
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(text).toContain("Try another email");
    expect(text).not.toContain("Email me a sign-in link");
  });

  test("a refusal of any other kind asks no mailbox for anything, whoever holds the address", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const sent = fixture.mail.transport.sent.length;
    const { response } = await flow.signInByDirectory(person.email, "subject", {
      claims: { email_verified: false },
    });
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("email_unverified");
    expect(fixture.mail.transport.sent).toHaveLength(sent);
    expect(await flow.requestsOf(person.email)).toEqual([]);
    expect(response.headers.getSetCookie().join()).not.toContain(
      "answerable-sign-in",
    );
  });
});
