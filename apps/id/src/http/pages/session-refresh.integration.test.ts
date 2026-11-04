import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { magicLinkFlow } from "../../__tests__/magic-link-flow.ts";
import { sessions } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

// A directory session is refreshed a day after it was made, on any read. A refresh sets the
// session cookie, which the OAuth provider's after-hook takes for a new sign-in: it runs the
// authorisation again and replaces the response. So the later steps of an authorisation keep
// the session as it is, and the steps that have no authorisation to replace still slide it.

const day = 86_400_000;

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
async function signedInAtFirm() {
  const of = await flow.seedOrganization(`refresh-${++nextFirm}`, true);
  await flow.allowClient(of.id);
  return flow.directorySignIn(of, undefined, `p-${createId()}`);
}

/** Five days left of seven: the session passed its one-day point two days ago. */
async function makeDue(userId: string) {
  const expiresAt = new Date(Date.now() + 5 * day);
  await fixture.db
    .update(sessions)
    .set({ expiresAt })
    .where(eq(sessions.userId, userId));
  return expiresAt;
}
const expiryOf = async (userId: string) =>
  (await flow.sessionsOf(userId))[0]!.expiresAt;

const sessionCookiesIn = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((line) => line.includes("session_token"));

async function selection(cookie: string) {
  const started = await flow.protocol(
    `/oauth2/authorize?${flow.authorizationQuery()}`,
    { cookie },
  );
  const url = new URL(started.headers.get("location")!);
  expect(url.pathname).toBe("/authorize");
  return url.search.slice(1);
}

const form = (cookie: string, body: Record<string, string>) => ({
  method: "POST",
  headers: {
    cookie,
    origin: fixture.environment.betterAuthUrl,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(body),
});

describe("a directory session that falls due during one authorisation", () => {
  test("each page answers as itself, the session stays as it was, and the code it ends with is real", async () => {
    const person = await signedInAtFirm();
    const query = await selection(person.cookie);
    const due = await makeDue(person.userId);

    const chooser = await fixture.app.request(`/authorize?${query}`, {
      headers: { cookie: person.cookie },
    });
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain(person.memberId);
    expect(sessionCookiesIn(chooser)).toEqual([]);

    const chosen = await fixture.app.request(
      `/authorize?${query}`,
      form(person.cookie, { member: person.memberId }),
    );
    expect(chosen.status).toBe(302);
    const consent = new URL(chosen.headers.get("location")!);
    expect(consent.pathname).toBe("/consent");
    expect(sessionCookiesIn(chosen)).toEqual([]);

    const asked = await fixture.app.request(consent.pathname + consent.search, {
      headers: { cookie: person.cookie },
    });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("decision");
    expect(sessionCookiesIn(asked)).toEqual([]);

    const accepted = await fixture.app.request(
      consent.pathname + consent.search,
      form(person.cookie, { decision: "accept" }),
    );
    expect(accepted.status).toBe(302);
    expect(sessionCookiesIn(accepted)).toEqual([]);
    const code = new URL(accepted.headers.get("location")!).searchParams.get(
      "code",
    );
    expect(code).toBeString();

    expect(await expiryOf(person.userId)).toEqual(due);
  });

  test("the same steps, called as the API, answer their own shapes", async () => {
    const person = await signedInAtFirm();
    const query = await selection(person.cookie);
    const due = await makeDue(person.userId);

    const read = await flow.protocol("/oauth2/flow", {
      cookie: person.cookie,
      json: { oauth_query: query },
    });
    expect(read.status).toBe(200);
    expect(sessionCookiesIn(read)).toEqual([]);
    expect((await read.json()).memberships).toBeArray();

    // The token at the end is what the two pages above stop short of proving.
    const tokens = await flow.finishAuthorization(
      query,
      person.cookie,
      person.memberId,
    );
    expect(tokens.refresh_token).toBeString();

    expect(await expiryOf(person.userId)).toEqual(due);
  });
});

describe("where a due session still slides", () => {
  test("an application's authorisation start refreshes it and goes to the selection page", async () => {
    const person = await signedInAtFirm();
    const due = await makeDue(person.userId);
    const started = await flow.protocol(
      `/oauth2/authorize?${flow.authorizationQuery()}`,
      { cookie: person.cookie },
    );
    expect(new URL(started.headers.get("location")!).pathname).toBe(
      "/authorize",
    );
    expect(sessionCookiesIn(started)).toHaveLength(1);
    expect((await expiryOf(person.userId)).getTime()).toBeGreaterThan(
      due.getTime() + day,
    );
  });

  test("reading the session refreshes it", async () => {
    const person = await signedInAtFirm();
    const due = await makeDue(person.userId);
    const read = await fixture.app.request("/auth/get-session", {
      headers: { cookie: person.cookie },
    });
    expect(read.status).toBe(200);
    expect(sessionCookiesIn(read)).toHaveLength(1);
    expect((await expiryOf(person.userId)).getTime()).toBeGreaterThan(
      due.getTime() + day,
    );
  });
});

describe("a browser holding a due session signs in through a directory", () => {
  test("a new sign-in resumes the authorisation it was started for", async () => {
    const person = await signedInAtFirm();
    await makeDue(person.userId);
    const query = await selection(person.cookie);
    const other = await flow.seedOrganization(`refresh-${++nextFirm}`, true);
    await flow.allowClient(other.id);
    const email = `ada@${other.domain}`;
    const { response } = await flow.signInByDirectory(email, `p-${createId()}`, {
      cookie: person.cookie,
      query,
    });
    expect(response.status).toBe(302);
    const resumed = new URL(response.headers.get("location")!);
    expect(["/authorize", "/consent"]).toContain(resumed.pathname);
    expect(resumed.searchParams.get("client_id")).toBeString();
  });

  test("a directory's refusal is the refusal, not the old session's authorisation", async () => {
    const person = await signedInAtFirm();
    const query = await selection(person.cookie);
    const other = await flow.seedOrganization(`refresh-${++nextFirm}`, true);
    await makeDue(person.userId);
    const { response } = await flow.signInByDirectory(
      `ada@${other.domain}`,
      `p-${createId()}`,
      {
        cookie: person.cookie,
        query,
        claims: { email_verified: false },
      },
    );
    expect(response.status).toBe(302);
    const landed = new URL(response.headers.get("location")!);
    expect(landed.pathname).toBe("/error");
    expect(landed.searchParams.get("error")).toBe("email_unverified");
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
  });
});
