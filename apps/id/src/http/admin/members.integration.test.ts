import { approveMachineCapability } from "../../__tests__/capabilities.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { platformWriteService } from "../../__tests__/platform-context.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./members.ts";
import * as clientsImplementation from "../../services/clients.ts";
const clients = {
  ...clientsImplementation,
  createClient: platformWriteService(clientsImplementation.createClient),
  linkResource: platformWriteService(clientsImplementation.linkResource),
};
import {
  adminOperations,
  adminOperationResults,
} from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
type Kind = Parameters<AdminFixture["headers"]>[0];
async function configurationTag(path: string, headers: Headers) {
  const response = await fixture.app.request(`${path}/configuration`, {
    headers,
  });
  return (
    response.headers.get("ETag") ?? '"00000000-0000-7000-8000-000000000000:1"'
  );
}
async function request(
  organizationId: string,
  suffix = "",
  method = "GET",
  body?: unknown,
  kind: Kind = "platformAdmin",
  action?: string,
  targetId?: string,
) {
  const headers = fixture.headers(kind);
  const requestId = createId();
  headers.set("x-request-id", requestId);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method === "PATCH")
    headers.set(
      "If-Match",
      await configurationTag(
        `/api/admin/v1/organizations/${organizationId}/members${suffix}`,
        headers,
      ),
    );
  const response = await fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/members${suffix}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
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
      expect(
        action,
        "Every successful write must specify its expected audit action",
      ).toBeDefined();
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event).toMatchObject({
        action,
        organizationId,
        requestId,
        actorType: typeof kind === "string" ? "user" : "client",
        actorId:
          typeof kind === "string"
            ? fixture.principals[kind].userId
            : fixture.platform.client.clientId,
        targetType: action!.startsWith("group_member.")
          ? "group_member"
          : "member",
      });
      const expectedTargetId = targetId ?? (await response.clone().json()).id;
      expect(event.targetId).toBe(expectedTargetId);
    } else expect(events).toHaveLength(0);
  }
  return response;
}
const past = "2000-01-01T00:00:00.000Z";
const future = "2100-01-01T00:00:00.000Z";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { members, users } from "../../db/schema/index.ts";
async function freshMember() {
  const subject = createId();
  const email = `${subject}@tenant.example.com`;
  fixture.issuer.enqueue({
    sub: subject,
    email,
    email_verified: true,
    name: "Fresh member",
  });
  const callbackURL = fixture.trustedOrigin + "/callback";
  const result = await signInThroughIdp(fixture.app, {
    providerId: fixture.tenant.slug,
    callbackURL,
  });
  expect(result.location).toBe(callbackURL);
  const [member] = await fixture.db
    .select({ id: members.id, userId: users.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, fixture.tenant.organizationId),
        eq(users.email, email),
      ),
    );
  expect(member).toBeDefined();
  return member!;
}
test("tenant and platform readers read members with organisation isolation", async () => {
  for (const principal of [
    fixture.principals.tenantReader,
    fixture.principals.outsider,
  ]) {
    for (const suffix of ["", `/${principal.memberId}`]) {
      expect(
        (
          await request(
            principal.organizationId,
            suffix,
            "GET",
            undefined,
            "tenantReader",
          )
        ).status,
      ).toBe(principal === fixture.principals.tenantReader ? 200 : 404);
      expect(
        (
          await request(
            principal.organizationId,
            suffix,
            "GET",
            undefined,
            "platformReader",
          )
        ).status,
      ).toBe(200);
    }
  }
  const row = await (
    await request(
      fixture.tenant.organizationId,
      `/${fixture.principals.tenantReader.memberId}`,
    )
  ).json();
  expect(row).not.toHaveProperty("role");
  expect(row.groups).toBeArray();
  expect(row.effective).toBe(true);
});
test("tenant administrator, users-only tenant, platform administrator and machine change windows and remove fresh members", async () => {
  const id = fixture.tenant.organizationId;
  const kinds: Kind[] = [
    "tenantAdmin",
    "tenantUsersOnly",
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ];
  for (const kind of kinds) {
    const member = await freshMember();
    const suffix = `/${member.id}`;
    expect(
      (
        await request(
          id,
          suffix,
          "PATCH",
          { validUntil: null },
          kind,
          "member.updated",
          member.id,
        )
      ).status,
    ).toBe(200);
    const updated = await request(
      id,
      suffix,
      "PATCH",
      { validFrom: past, validUntil: future },
      kind,
      "member.updated",
      member.id,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      validFrom: past,
      validUntil: future,
      effective: true,
    });
    expect(
      (
        await request(
          id,
          suffix,
          "PATCH",
          { validFrom: null },
          kind,
          "member.updated",
          member.id,
        )
      ).status,
    ).toBe(200);
    const invalid = await request(
      id,
      suffix,
      "PATCH",
      { validFrom: future, validUntil: past },
      kind,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "constraint_violation",
    });
    expect(
      (
        await request(
          id,
          suffix,
          "DELETE",
          undefined,
          kind,
          "member.removed",
          member.id,
        )
      ).status,
    ).toBe(204);
    const revoked = await request(id, suffix);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      membershipStatus: "revoked",
      effective: false,
    });
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, member.id),
          eq(auditEvents.action, "member.removed"),
        ),
      );
    expect(event!.data).toMatchObject({
      userId: member.userId,
      after: { membershipStatus: "revoked" },
    });
    expect(
      (
        await request(
          id,
          suffix,
          "DELETE",
          undefined,
          kind,
          "member.removal_unchanged",
          member.id,
        )
      ).status,
    ).toBe(204);
    const reinstated = await request(
      id,
      suffix + "/reinstate",
      "POST",
      undefined,
      kind,
      "member.reinstated",
      member.id,
    );
    expect(reinstated.status).toBe(200);
    expect(await reinstated.json()).toMatchObject({
      id: member.id,
      membershipStatus: "active",
      revokedAt: null,
    });
    expect(
      (
        await request(
          id,
          suffix,
          "DELETE",
          undefined,
          kind,
          "member.removed",
          member.id,
        )
      ).status,
    ).toBe(204);
  }
});
test("member filters, pagination and validation", async () => {
  const id = fixture.tenant.organizationId;
  const member = await freshMember();
  expect((await request(id, `/${member.id}`, "PATCH", {})).status).toBe(400);
  expect(
    (await request(id, `/${member.id}`, "PATCH", { validFrom: "bad" })).status,
  ).toBe(400);
  expect((await request(id, "/bad-id")).status).toBe(400);
  expect((await request(id, "?effective=yes")).status).toBe(400);
  expect(
    (
      await (await request(id, "?q=FRESH%20MEMBER&effective=true")).json()
    ).items.map((r: { id: string }) => r.id),
  ).toEqual([member.id]);
  expect(
    (
      await request(
        id,
        `/${member.id}`,
        "PATCH",
        { validUntil: past },
        "tenantAdmin",
        "member.updated",
        member.id,
      )
    ).status,
  ).toBe(200);
  expect(
    (await (await request(id, "?effective=false")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toContain(member.id);
  expect(
    (await (await request(id, "?effective=true")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).not.toContain(member.id);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await (
      await request(id, "?limit=1" + (cursor ? `&cursor=${cursor}` : ""))
    ).json();
    seen.push(...page.items.map((row: { id: string }) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  const expected = await fixture.db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.organizationId, id));
  expect(seen).toEqual(
    expected
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
});

test.each(["PATCH", "DELETE", "POST"])(
  "member %s rechecks authority after middleware admission",
  async (method) => {
    const actor = fixture.principals.tenantUsersOnly;
    const target = await freshMember();
    const requestId = createId();
    const headers = fixture.headers("tenantUsersOnly");
    headers.set("x-request-id", requestId);
    headers.set("content-type", "application/json");
    if (method === "PATCH")
      headers.set(
        "If-Match",
        await configurationTag(
          `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${target.id}`,
          headers,
        ),
      );
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      // HTTP principal resolution has already admitted this actor. Commit a
      // revocation before the command enters its transaction.
      await fixture.db
        .update(members)
        .set({
          status: "revoked",
          revokedAt: new Date(),
        })
        .where(eq(members.id, actor.memberId));
      return original(...args);
    }) as typeof original);
    try {
      const response = await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${target.id}${method === "POST" ? "/reinstate" : ""}`,
        {
          method,
          headers,
          body:
            method === "PATCH"
              ? JSON.stringify({ validUntil: future })
              : undefined,
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "insufficient_scope",
      });
      const [unchanged] = await fixture.db
        .select()
        .from(members)
        .where(eq(members.id, target.id));
      expect(unchanged!.validUntil).toBeNull();
      expect(unchanged!.status).toBe("active");
      expect(
        await fixture.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.requestId, requestId),
              eq(auditEvents.outcome, "success"),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, actor.memberId));
    }
  },
);

test("an owned machine with org:users changes only its tenant's members", async () => {
  const client = await clients.createClient(
    fixture.db,
    {
      requestId: "tenant-command-setup",
    },
    {
      clientId: `tenant-${createId()}`,
      name: "Tenant member administrator",
      organizationId: fixture.tenant.organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      redirectUris: [],
      clientCredentialsScopes: ["org:users"],
    },
  );
  await clients.linkResource(
    fixture.db,
    {
      requestId: "tenant-command-setup",
    },
    client.clientId,
    fixture.platform.adminResource,
  );
  await approveMachineCapability(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    clientId: client.clientId,
    resource: fixture.platform.adminResource,
    scopes: ["org:users"],
  });
  const issued = await fixture.app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "org:users",
      resource: fixture.platform.adminResource,
    }),
  });
  expect(issued.status).toBe(200);
  const { access_token: bearer } = await issued.json();
  const target = await freshMember();
  const headers = fixture.headers({ bearer });
  headers.set("content-type", "application/json");
  for (const [organizationId, memberId, expected] of [
    [fixture.tenant.organizationId, target.id, 200],
    [
      fixture.outsider.organizationId,
      fixture.principals.outsider.memberId,
      404,
    ],
  ] as const) {
    headers.set(
      "If-Match",
      await configurationTag(
        `/api/admin/v1/organizations/${organizationId}/members/${memberId}`,
        headers,
      ),
    );
    const response = await fixture.app.request(
      `/api/admin/v1/organizations/${organizationId}/members/${memberId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ validUntil: future }),
      },
    );
    expect(response.status).toBe(expected);
  }
});

test("member commands recover the same result without repeating their audit effect", async () => {
  const target = await freshMember();
  for (const [method, suffix, body] of [
    ["PATCH", "", { validUntil: future }],
    ["DELETE", "", undefined],
    ["POST", "/reinstate", undefined],
  ] as const) {
    const headers = fixture.headers("tenantAdmin");
    headers.set("content-type", "application/json");
    const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${target.id}${suffix}`;
    if (method === "PATCH")
      headers.set("If-Match", await configurationTag(path, headers));
    const send = () =>
      fixture.app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const first = await send();
    expect(first.status).toBe(method === "DELETE" ? 204 : 200);
    const operationId = first.headers.get("Operation-Id");
    expect(operationId).toBeTruthy();
    const firstBody = await first.text();
    const replay = await send();
    expect(replay.status).toBe(first.status);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(operationId);
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId!)),
    ).toHaveLength(1);
    const [operation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, operationId!));
    expect(operation!.authorityScope).toBe(
      `tenant:${fixture.tenant.organizationId}`,
    );
    const changed = await fixture.app.request(
      path.replace(target.id, fixture.principals.tenantReader.memberId),
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "idempotency_key_reused",
      retryable: false,
    });
    headers.set("Idempotency-Key", createId());
    if (method === "PATCH")
      headers.set("If-Match", await configurationTag(path, headers));
    const unchanged = await send();
    const [noop] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, unchanged.headers.get("Operation-Id")!));
    expect(noop!.outcome).toBe("noop");
  }
});

test("member replay requires current authority and cannot rerun after recovery data is removed", async () => {
  const target = await freshMember();
  const actor = fixture.principals.tenantUsersOnly;
  const headers = fixture.headers("tenantUsersOnly");
  const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${target.id}`;
  const send = () => fixture.app.request(path, { method: "DELETE", headers });
  const first = await send();
  expect(first.status).toBe(204);
  const operationId = first.headers.get("Operation-Id")!;
  const original = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = afterBrokerRead(original, (async (
    ...args: Parameters<typeof original>
  ) => {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, actor.memberId));
    return original(...args);
  }) as typeof original);
  try {
    expect((await send()).status).toBe(403);
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, actor.memberId));
  }
  await fixture.db
    .delete(adminOperationResults)
    .where(eq(adminOperationResults.operationId, operationId));
  const expired = await send();
  expect(expired.status).toBe(410);
  expect(await expired.json()).toMatchObject({
    code: "operation_result_expired",
    operationId,
  });
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId)),
  ).toHaveLength(1);
  headers.delete("Idempotency-Key");
  expect((await send()).status).toBe(400);
});

test("simultaneous member retries commit only one removal", async () => {
  const target = await freshMember();
  const headers = fixture.headers("tenantAdmin");
  const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${target.id}`;
  const send = () => fixture.app.request(path, { method: "DELETE", headers });
  const responses = await Promise.all([send(), send()]);
  expect(responses.some((response) => response.status === 204)).toBe(true);
  for (const response of responses) {
    expect([204, 409]).toContain(response.status);
    if (response.status === 409)
      expect(await response.json()).toMatchObject({
        code: "operation_in_progress",
        retryable: true,
      });
  }
  const recovered = await send();
  expect(recovered.status).toBe(204);
  expect(recovered.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(
        eq(auditEvents.operationId, recovered.headers.get("Operation-Id")!),
      ),
  ).toHaveLength(1);
});

test("all member reads recheck current membership after middleware and keep projections private", async () => {
  const target = await freshMember();
  const base = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members`;
  for (const [suffix, kind] of [
    ["", "tenantReader"],
    [`/${target.id}`, "tenantReader"],
    [`/${target.id}/configuration`, "tenantUsersOnly"],
  ] as const) {
    const path = base + suffix;
    const headers = fixture.headers(kind);
    const read = () => fixture.app.request(path, { headers });
    const accepted = await read();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals[kind].memberId));
      return original(...args);
    }) as typeof original);
    try {
      const denied = await read();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals[kind].memberId));
    }
  }
  expect(
    (
      await fixture.app.request(`${base}/${target.id}`, {
        headers: fixture.headers("tenantUsersOnly"),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fixture.app.request(`${base}/${target.id}/configuration`, {
        headers: fixture.headers("tenantReader"),
      })
    ).status,
  ).toBe(403);
});
