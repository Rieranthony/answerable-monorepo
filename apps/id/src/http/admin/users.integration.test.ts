import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import {
  auditEvents,
  members,
  oauthAccessTokens,
  oauthRefreshTokens,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
type Kind = Parameters<AdminFixture["headers"]>[0];
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  kind: Kind = "platformAdmin",
  audit?: {
    action: string;
    targetId: string;
    targetType: string;
    organizationId: string | null;
    data?: Record<string, unknown>;
  },
) {
  const headers = fixture.headers(kind);
  const requestId = createId();
  headers.set("x-request-id", requestId);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fixture.app.request("/api/admin/v1" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (method !== "GET") {
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.requestId, requestId),
          eq(auditEvents.outcome, "success"),
        ),
      );
    if (response.ok) {
      expect(audit, "Every write asserts its audit").toBeDefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        ...audit,
        requestId,
        actorType: typeof kind === "string" ? "user" : "client",
        actorId:
          typeof kind === "string"
            ? fixture.principals[kind].userId
            : fixture.platform.client.clientId,
      });
    } else expect(events).toHaveLength(0);
  }
  return response;
}
async function signIn(subject: string) {
  fixture.issuer.enqueue({
    sub: subject,
    email: subject + "@tenant.example.com",
    email_verified: true,
    name: "Fresh user",
  });
  return signInThroughIdp(fixture.app, {
    providerId: fixture.tenant.slug,
    callbackURL: fixture.trustedOrigin + "/callback",
    errorCallbackURL: fixture.trustedOrigin + "/error",
  });
}
async function freshUser() {
  const subject = createId();
  const signedIn = await signIn(subject);
  expect(signedIn.location).toBe(fixture.trustedOrigin + "/callback");
  const [row] = await fixture.db
    .select({ userId: users.id, memberId: members.id })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(eq(users.email, subject + "@tenant.example.com"));
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, row!.userId));
  const values = {
    id: createId(),
    userId: row!.userId,
    sessionId: session!.id,
    clientId: fixture.platform.client.clientId,
    token: createId(),
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  };
  await fixture.db.insert(oauthRefreshTokens).values(values);
  await fixture.db
    .insert(oauthAccessTokens)
    .values({ ...values, id: createId(), token: createId() });
  return {
    ...row!,
    subject,
    sessionId: session!.id,
    cookie: cookie(signedIn.cookies),
  };
}
function cookie(cookies: string[]) {
  return cookies.map((value) => value.split(";", 1)[0]).join("; ");
}
async function deadCookie(value: string) {
  const response = await fixture.app.request("/auth/get-session", {
    headers: { Cookie: value },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
}
import { routes } from "./users.ts";
describeAdminRoutes(routes, () => fixture);

test("platform admin and machine administer a fresh user through revocation, disable, retirement and erasure", async () => {
  for (const kind of [
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ] satisfies Kind[]) {
    const fresh = await freshUser();
    const id = fresh.userId;
    const path = "/users/" + id;
    const audit = (action: string, data?: Record<string, unknown>) => ({
      action,
      targetType: "user",
      targetId: id,
      organizationId: null,
      ...(data ? { data } : {}),
    });
    const filtered = await request(
      `/users?q=${fresh.subject.toUpperCase()}&status=active&organization=${fixture.tenant.organizationId}`,
      "GET",
      undefined,
      kind,
    );
    expect(filtered.status).toBe(200);
    expect(
      (await filtered.json()).items.map((r: { id: string }) => r.id),
    ).toEqual([id]);
    const detail = await (await request(path, "GET", undefined, kind)).json();
    expect(detail).toMatchObject({
      id,
      sessionCount: 1,
      memberships: [
        {
          memberId: fresh.memberId,
          organizationId: fixture.tenant.organizationId,
          slug: fixture.tenant.slug,
          effective: true,
        },
      ],
    });
    expect(detail.accounts).toHaveLength(1);
    expect(Object.keys(detail.accounts[0]).sort()).toEqual([
      "directoryId",
      "directoryUserId",
      "issuer",
      "providerId",
    ]);
    const listed = await request(path + "/sessions", "GET", undefined, kind);
    expect(listed.status).toBe(200);
    const sessionBody = await listed.json();
    expect(sessionBody.items).toHaveLength(1);
    expect(JSON.stringify(sessionBody)).not.toContain('"token"');
    expect(
      (
        await request(
          path + "/sessions/" + fresh.sessionId,
          "DELETE",
          undefined,
          kind,
          {
            action: "session.revoked",
            targetType: "session",
            targetId: fresh.sessionId,
            organizationId: null,
            data: { userId: id },
          },
        )
      ).status,
    ).toBe(204);
    await deadCookie(fresh.cookie);
    const again = await signIn(fresh.subject);
    expect(again.location).toBe(fixture.trustedOrigin + "/callback");
    // Give the new session live tokens so disable must revoke both kinds.
    const [newSession] = await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, id));
    for (const table of [oauthRefreshTokens, oauthAccessTokens])
      await fixture.db
        .update(table)
        .set({ revoked: null, sessionId: newSession!.id })
        .where(eq(table.userId, id));
    const disabled = await request(
      path + "/disable",
      "POST",
      undefined,
      kind,
      audit("user.disabled", {
        sessions: 1,
        refreshTokens: 1,
        accessTokens: 1,
      }),
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      status: "disabled",
      disabledAt: expect.any(String),
    });
    await deadCookie(cookie(again.cookies));
    expect(
      await fixture.db.select().from(sessions).where(eq(sessions.userId, id)),
    ).toHaveLength(0);
    for (const table of [oauthRefreshTokens, oauthAccessTokens])
      expect(
        (await fixture.db.select().from(table).where(eq(table.userId, id)))[0]
          ?.revoked,
      ).toBeInstanceOf(Date);
    const refused = await signIn(fresh.subject);
    expect(new URL(refused.location!).searchParams.get("error")).toBe(
      "user_disabled",
    );
    expect(
      (
        await request(
          path + "/enable",
          "POST",
          undefined,
          kind,
          audit("user.enabled", { status: "active" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          path + "/disable",
          "POST",
          undefined,
          kind,
          audit("user.disabled", {
            sessions: 0,
            refreshTokens: 0,
            accessTokens: 0,
          }),
        )
      ).status,
    ).toBe(200);
    const retired = await request(
      path + "/retire-email",
      "POST",
      undefined,
      kind,
      audit("user.email_retired", {
        retiredEmail: fresh.subject + "@tenant.example.com",
      }),
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({
      email: id + "@retired.invalid",
      retiredEmail: fresh.subject + "@tenant.example.com",
    });
    const enable = await request(path + "/enable", "POST", undefined, kind);
    expect(enable.status).toBe(409);
    expect(await enable.json()).toMatchObject({ code: "user_email_retired" });
    const wrong = await request(path, "DELETE", { confirm: createId() }, kind);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "confirmation_mismatch" });
    expect(
      (
        await request(
          path,
          "DELETE",
          { confirm: id },
          kind,
          audit("user.erased"),
        )
      ).status,
    ).toBe(204);
    expect((await request(path, "GET", undefined, kind)).status).toBe(404);
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, id),
            eq(auditEvents.action, "user.erased"),
          ),
        ),
    ).toHaveLength(1);
  }
});
test("user pagination, platform reader access, validation and lifecycle conflicts", async () => {
  const fresh = await freshUser();
  const path = "/users/" + fresh.userId;
  expect((await request(path, "GET", undefined, "platformReader")).status).toBe(
    200,
  );
  for (const suffix of ["?status=bad", "?organization=bad", "?q=", "/bad-id"])
    expect((await request("/users" + suffix)).status).toBe(400);
  expect((await request(path, "DELETE", {})).status).toBe(400);
  for (const [suffix, code] of [
    ["/enable", "user_already_active"],
    ["/retire-email", "user_not_disabled"],
  ]) {
    const response = await request(path + suffix, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
  }
  const audit = (action: string) => ({
    action,
    targetType: "user",
    targetId: fresh.userId,
    organizationId: null,
  });
  expect(
    (
      await request(
        path + "/disable",
        "POST",
        undefined,
        "platformAdmin",
        audit("user.disabled"),
      )
    ).status,
  ).toBe(200);
  const repeat = await request(path + "/disable", "POST");
  expect(repeat.status).toBe(409);
  expect(await repeat.json()).toMatchObject({ code: "user_already_disabled" });
  expect(
    (
      await request(
        path + "/retire-email",
        "POST",
        undefined,
        "platformAdmin",
        audit("user.email_retired"),
      )
    ).status,
  ).toBe(200);
  const retire = await request(path + "/retire-email", "POST");
  expect(retire.status).toBe(409);
  expect(await retire.json()).toMatchObject({
    code: "user_email_already_retired",
  });
  const inert = createId();
  await fixture.db
    .insert(users)
    .values({ id: inert, name: "Inert", email: inert + "@example.com" });
  const enable = await request("/users/" + inert + "/enable", "POST");
  expect(enable.status).toBe(409);
  expect(await enable.json()).toMatchObject({ code: "user_inert" });
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      "/users?limit=2" + (cursor ? "&cursor=" + cursor : ""),
      "GET",
      undefined,
      "platformReader",
    );
    const page = await response.json();
    seen.push(...page.items.map((r: { id: string }) => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(
    (await fixture.db.select({ id: users.id }).from(users))
      .map((r) => r.id)
      .sort()
      .reverse(),
  );
});
