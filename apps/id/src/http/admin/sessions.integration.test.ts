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
import { routes } from "./sessions.ts";
describeAdminRoutes(routes, () => fixture);

test("platform administrator and machine revoke global user sessions", async () => {
  for (const kind of [
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ] satisfies Kind[]) {
    const fresh = await freshUser();
    const path = `/users/${fresh.userId}/sessions`;
    expect((await request(path, "GET", undefined, kind)).status).toBe(200);
    for (const count of [1, 0]) {
      const response = await request(path, "DELETE", undefined, kind, {
        action: "session.revoked_all",
        targetType: "user",
        targetId: fresh.userId,
        organizationId: null,
        data: {
          userId: fresh.userId,
          sessions: count,
          refreshTokens: count,
          accessTokens: count,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: count });
    }
    await deadCookie(fresh.cookie);
  }
});
test("single-session revocation preserves another user's session; pagination and UUID validation", async () => {
  const fresh = await freshUser();
  const other = await freshUser();
  const path = `/users/${fresh.userId}/sessions`;
  expect((await request(path, "GET", undefined, "platformReader")).status).toBe(
    200,
  );
  expect((await request(path + "/" + other.sessionId, "DELETE")).status).toBe(
    404,
  );
  for (const url of ["/users/bad/sessions", path + "/bad"])
    expect(
      (await request(url, url.endsWith("/bad") ? "DELETE" : "GET")).status,
    ).toBe(400);
  await fixture.db.insert(sessions).values({
    id: createId(),
    userId: fresh.userId,
    token: createId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  const first = await (await request(path + "?limit=1")).json();
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBeString();
  const second = await (
    await request(path + "?limit=1&cursor=" + first.nextCursor)
  ).json();
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(second.items[0].id).not.toBe(first.items[0].id);
  expect(
    (
      await request(
        path + "/" + fresh.sessionId,
        "DELETE",
        undefined,
        "platformAdmin",
        {
          action: "session.revoked",
          targetId: fresh.sessionId,
          targetType: "session",
          organizationId: null,
          data: { userId: fresh.userId },
        },
      )
    ).status,
  ).toBe(204);
  await deadCookie(fresh.cookie);
  expect((await request(path + "/" + fresh.sessionId, "DELETE")).status).toBe(
    404,
  );
  expect(
    (await (await request(`/users/${other.userId}/sessions`)).json()).items,
  ).toHaveLength(1);
});

test("tenant session aliases cannot expose or revoke a shared person's global login", async () => {
  const fresh = await freshUser();
  await fixture.db.insert(members).values({
    id: createId(),
    userId: fresh.userId,
    organizationId: fixture.principals.outsider.organizationId,
  });
  const path = `/organizations/${fixture.tenant.organizationId}/members/${fresh.memberId}/sessions`;
  for (const kind of ["tenantUsersOnly", "platformAdmin"] as const)
    for (const method of ["GET", "DELETE"])
      expect((await request(path, method, undefined, kind)).status).toBe(404);
  const response = await fixture.app.request("/auth/get-session", {
    headers: { Cookie: fresh.cookie },
  });
  expect((await response.json()).session.id).toBe(fresh.sessionId);
  for (const table of [oauthRefreshTokens, oauthAccessTokens])
    expect(
      (
        await fixture.db
          .select()
          .from(table)
          .where(eq(table.userId, fresh.userId))
      )[0]!.revoked,
    ).toBeNull();
  for (const method of ["GET", "DELETE"])
    expect(
      (
        await request(
          `/users/${fresh.userId}/sessions`,
          method,
          undefined,
          "tenantUsersOnly",
        )
      ).status,
    ).toBe(403);
  const summary = await request(
    `/organizations/${fixture.tenant.organizationId}/summary`,
    "GET",
    undefined,
    "tenantAdmin",
  );
  expect(summary.status).toBe(200);
  expect(await summary.json()).not.toHaveProperty("sessions");
});
