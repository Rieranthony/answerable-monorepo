import { expect } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  accounts,
  auditEvents,
  magicLinkRequests,
  members,
  sessions,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { AdminFixture } from "./admin.ts";
import { magicLinkFirms } from "./magic-link.ts";
import { codeIn, tokenIn } from "./magic-link-requests.ts";

export const cookieOf = (setCookies: string[]) =>
  setCookies.map((value) => value.split(";", 1)[0]).join("; ");

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

  /** Ask for a link, and wait until the job has run. */
  async function ask(
    email: string,
    {
      cookie,
      query = "",
      headers,
    }: {
      cookie?: string;
      query?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const before = fixture.mail.transport.sent.length;
    const response = await post(
      `/login${query ? `?${query}` : ""}`,
      { email },
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
    post,
    ask,
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
