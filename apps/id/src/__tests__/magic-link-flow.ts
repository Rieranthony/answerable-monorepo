import { expect } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  accounts,
  auditEvents,
  magicLinkRequests,
  members,
  organizationDomains,
  sessions,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { domainVerificationRecord } from "../services/domain-verification.ts";
import { proveDomain } from "../services/domains.ts";
import { setMagicLinkAdmission } from "../services/organizations.ts";
import type { AdminFixture } from "./admin.ts";
import type { OidcClaims } from "./oidc-issuer.ts";
import { magicLinkFirms } from "./magic-link.ts";
import { codeIn, tokenIn } from "./magic-link-requests.ts";
import { inPlatformWrite } from "./platform-context.ts";

export const cookieOf = (setCookies: string[]) =>
  setCookies.map((value) => value.split(";", 1)[0]).join("; ");

/** A browser's cookies after a response: a new value replaces the old, and an expired one goes. */
export function cookiesAfter(held: string, setCookies: string[]) {
  const jar = new Map(
    held
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const),
  );
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

/** A browser and what it does on the sign-in pages, through the real app. */
export function magicLinkFlow(fixture: AdminFixture) {
  const firms = magicLinkFirms(fixture);
  const origin = fixture.environment.betterAuthUrl;

  /** A person the firm lists, as staff import or a directory sign-in leaves one. */
  async function listed(
    organization: { id: string; domain: string },
    local = `person-${createId()}`,
  ) {
    const userId = createId();
    const email = `${local}@${organization.domain}`;
    await fixture.db.insert(users).values({
      id: userId,
      name: local,
      email,
      emailVerified: true,
      status: "active",
    });
    const memberId = createId();
    await fixture.db.insert(members).values({
      id: memberId,
      organizationId: organization.id,
      userId,
    });
    return { email, userId, memberId };
  }

  /** Prove this domain as its record in DNS would, through the real command. */
  async function proveDomainOf(organizationId: string, domain: string) {
    const [row] = await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.domain, domain));
    await inPlatformWrite(fixture.db, (context) =>
      proveDomain(context, organizationId, row!.id, [
        [domainVerificationRecord(row!).value],
      ]),
    );
    return row!.id;
  }

  /** A firm's one domain proved and the firm in domain mode, through the real commands. */
  async function openToDomain(organization: { id: string; domain: string }) {
    const domainId = await proveDomainOf(organization.id, organization.domain);
    await inPlatformWrite(fixture.db, (context) =>
      setMagicLinkAdmission(context, organization.id, "domain"),
    );
    return domainId;
  }

  // Every test here comes from one machine, which the per-client budgets would see as one
  // office at full tilt. A test of those budgets names its own client.
  let posts = 0;
  const nextClient = () =>
    `198.18.${Math.floor(++posts / 20) % 250}.${Math.floor(posts / 5000) + 1}`;

  const post = async (
    path: string,
    fields: Record<string, string>,
    {
      cookie,
      headers,
    }: { cookie?: string; headers?: Record<string, string> } = {},
  ) =>
    fixture.app.request(path, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextClient(),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: new URLSearchParams(fields),
    });

  /** Ask for a link, and wait until the job has run. A firm with a directory as well needs
   * `method`, which is the choice page's button. */
  async function ask(
    email: string,
    {
      cookie,
      query = "",
      headers,
      method,
    }: {
      cookie?: string;
      query?: string;
      headers?: Record<string, string>;
      method?: "link";
    } = {},
  ) {
    const before = fixture.mail.transport.sent.length;
    const response = await post(
      `/login${query ? `?${query}` : ""}`,
      { email, ...(method ? { method } : {}) },
      { cookie, headers },
    );
    await fixture.mail.settled();
    const set = response.headers.getSetCookie();
    const mail = fixture.mail.transport.sent
      .slice(before)
      .find((message) => message.to === email);
    return {
      response,
      setCookies: set,
      cookie: cookieOf(set) || cookie || "",
      mail,
      token: mail && tokenIn(mail)!,
      code: mail && codeIn(mail)!,
    };
  }

  /** From a sign-in that went to the directory, through it and back, as a browser follows it:
   * the directory's redirect to the callback is a top-level GET, carrying the browser's cookies. */
  async function throughDirectory(
    started: Response,
    claims: OidcClaims,
    { cookie = "", client }: { cookie?: string; client?: string } = {},
  ) {
    expect(new URL(started.headers.get("location")!).origin).toBe(
      fixture.issuer.origin,
    );
    fixture.issuer.enqueue({
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000),
      ...claims,
    });
    const held = cookiesAfter(cookie, started.headers.getSetCookie());
    const upstream = await fetch(started.headers.get("location")!, {
      redirect: "manual",
    });
    const callback = new URL(upstream.headers.get("location")!);
    const response = await fixture.app.request(
      callback.pathname + callback.search,
      {
        headers: {
          cookie: held,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
          "cf-connecting-ip": client ?? nextClient(),
        },
      },
    );
    return {
      response,
      cookie: cookiesAfter(held, response.headers.getSetCookie()),
    };
  }

  /** The mail a connection's request queued, once its row says what became of the send. */
  async function sendOf(email: string, before: number) {
    for (let waited = 0; waited < 200; waited++) {
      const rows = await requestsOf(email);
      if (rows.at(-1)?.sendStatus !== "sending") break;
      await Bun.sleep(10);
    }
    return fixture.mail.transport.sent
      .slice(before)
      .find((message) => message.to === email);
  }

  /**
   * A browser chooses the directory, the directory verifies this person, and the callback
   * answers: the page asking for a code, or a refusal.
   */
  async function signInByDirectory(
    email: string,
    subject: string,
    {
      cookie,
      query = "",
      client,
      claims,
    }: {
      cookie?: string;
      query?: string;
      client?: string;
      claims?: Partial<OidcClaims>;
    } = {},
  ) {
    const before = fixture.mail.transport.sent.length;
    const started = await post(
      `/login${query ? `?${query}` : ""}`,
      { email, method: "directory" },
      {
        cookie,
        headers: client ? { "cf-connecting-ip": client } : undefined,
      },
    );
    const answer = await throughDirectory(
      started,
      { sub: subject, email, name: "Person", ...claims },
      { cookie, client },
    );
    const mail = await sendOf(email, before);
    return { ...answer, mail, code: mail && codeIn(mail)! };
  }

  const openConnection = (cookie = "") =>
    fixture.app.request("/connect-directory", {
      headers: cookie ? { cookie } : {},
    });
  const enterConnectionCode = (code: string, cookie = "", headers = {}) =>
    post("/connect-directory", { code }, { cookie, headers });

  const open = async (token: string, cookie = "") =>
    fixture.app.request(`/magic-link?token=${token}`, {
      headers: cookie ? { cookie } : {},
    });
  const follow = (token: string, cookie = "", headers = {}) =>
    post("/magic-link", { token }, { cookie, headers });
  const enter = (code: string, cookie = "", headers = {}) =>
    post("/magic-link/code", { code }, { cookie, headers });

  /** A session cookie out of a sign-in's response, ready to send. */
  function signedIn(response: Response) {
    expect(response.status).toBe(303);
    const cookie = cookieOf(response.headers.getSetCookie());
    expect(cookie).toContain("better-auth.session_token=");
    return cookie;
  }

  const requestsOf = (email: string) =>
    fixture.db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, email))
      .orderBy(magicLinkRequests.id);

  const sessionsOf = (userId: string) =>
    fixture.db.select().from(sessions).where(eq(sessions.userId, userId));

  const accountsOf = (userId: string) =>
    fixture.db.select().from(accounts).where(eq(accounts.userId, userId));

  const tokenRows = (identifier: string) =>
    fixture.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, identifier));

  /** The audit rows of a magic-link action for one request. */
  async function refusals(action: string, requestId: string) {
    const rows = await fixture.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action)));
    return rows.filter(
      (row) =>
        (row.data as { magicLinkRequestId?: string } | null)
          ?.magicLinkRequestId === requestId,
    );
  }

  return {
    ...firms,
    listed,
    proveDomainOf,
    openToDomain,
    post,
    ask,
    throughDirectory,
    sendOf,
    signInByDirectory,
    openConnection,
    enterConnectionCode,
    open,
    follow,
    enter,
    signedIn,
    requestsOf,
    sessionsOf,
    accountsOf,
    tokenRows,
    refusals,
  };
}

/** All of a response a person or a scanner could tell apart, apart from its cookie's value
 * and, when named, an address it echoes. */
export async function answerOf(response: Response, address?: string) {
  const headers: string[] = [];
  response.headers.forEach((value, name) =>
    headers.push(
      `${name}: ${name === "set-cookie" ? value.replace(/=[^;]+;/, "=VALUE;") : value}`,
    ),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: headers.sort(),
    body: address ? text.replaceAll(address, "ADDRESS") : text,
  };
}
