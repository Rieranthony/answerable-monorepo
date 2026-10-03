import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import {
  adminOperations,
  auditEvents,
  members,
  oauthResources,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 2 },
    { restrictedRole: true },
  );
});
afterAll(async () => fixture?.close());

type Actor = "platformAdmin" | "tenantAdmin";
/** One command of a family, prepared against fresh rows. */
type Command = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  status: number;
  /** Inputs that normalise to the same command and replay its receipt. */
  equivalent?: unknown[];
  /** A different input sent under the same key. */
  changed: { path?: string; body?: unknown };
  /** GET path whose ETag becomes If-Match (If-None-Match: * while it is 404). */
  precondition?: string;
  /** Sending this input again with a new key records a noop. */
  noop?: { body?: unknown };
};
type Row = {
  family: string;
  command: string;
  actor?: Actor;
  prepare: () => Promise<Command>;
};

const org = () => fixture.tenant.organizationId;
/** Values no audit fact may carry: personal data, session tokens, secrets. */
const privateValues: string[] = [];
const future = "2100-01-01T00:00:00.000Z";
async function seed(method: string, path: string, body?: unknown) {
  const headers = fixture.headers("platformAdmin");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (method === "PUT") headers.set("If-None-Match", "*");
  const response = await fixture.app.request(`/api/admin/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, path).toBeLessThan(300);
  return response.json();
}
async function person(session = false) {
  const id = createId();
  const email = `${id}@receipt.example`;
  const name = `Private ${id}`;
  await fixture.db.insert(users).values({ id, email, name, status: "active" });
  const sessionId = createId();
  privateValues.push(email, name, `secret-${sessionId}`);
  if (session)
    await fixture.db.insert(sessions).values({
      id: sessionId,
      userId: id,
      token: `secret-${sessionId}`,
      expiresAt: new Date(Date.now() + 60000),
    });
  return { id, sessionId };
}
async function member() {
  const { id } = await person();
  await fixture.db
    .insert(members)
    .values({ id, userId: id, organizationId: org() });
  return `/organizations/${org()}/members/${id}`;
}
async function resource(scopes = ["read", "write"]) {
  const identifier = `https://${createId()}.example/resource`;
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier,
    name: "Receipt",
    allowedScopes: scopes,
  });
  return identifier;
}
const sso = {
  issuer: "https://login.example.com",
  oidc: { clientId: "receipt-client", clientSecret: "receipt-secret" },
};
async function ssoOrganization() {
  const id = createId();
  const row = await seed("POST", "/organizations", {
    slug: `sso-${id}`,
    name: "SSO",
  });
  return { id: row.id as string, domain: `sso-${id}.example.com` };
}
async function capability() {
  const client = await seed("POST", "/clients", {
    clientId: `cap-${createId()}`,
    name: "Capability",
    organizationId: org(),
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["read", "write"],
  });
  return {
    clientId: client.clientId as string,
    resource: await resource(),
    grantKind: "client_credentials",
    scopes: ["write"],
  };
}

const rows: Row[] = [
  {
    family: "organization",
    command: "create",
    prepare: async () => ({
      method: "POST",
      path: "/organizations",
      body: { slug: `receipt-${createId()}`, name: "Receipt" },
      status: 201,
      changed: { body: { slug: `receipt-${createId()}`, name: "Different" } },
    }),
  },
  {
    family: "organization",
    command: "update",
    prepare: async () => {
      const { id } = await seed("POST", "/organizations", {
        slug: `receipt-${createId()}`,
        name: "Receipt",
      });
      return {
        method: "PATCH",
        path: `/organizations/${id}`,
        body: { name: "Changed" },
        status: 200,
        changed: { body: { name: "Different" } },
        precondition: `/organizations/${id}`,
        noop: {},
      };
    },
  },
  {
    family: "organization",
    command: "erase",
    prepare: async () => {
      const { id } = await seed("POST", "/organizations", {
        slug: `receipt-${createId()}`,
        name: "Receipt",
      });
      const other = createId();
      return {
        method: "DELETE",
        path: `/organizations/${id}?confirm=${id}`,
        status: 204,
        changed: { path: `/organizations/${other}?confirm=${other}` },
      };
    },
  },
  {
    family: "group",
    command: "create",
    prepare: async () => ({
      method: "POST",
      path: `/organizations/${org()}/groups`,
      body: { slug: `receipt-${createId()}`, name: "Receipt" },
      status: 201,
      changed: { body: { slug: `receipt-${createId()}`, name: "Different" } },
    }),
  },
  {
    family: "group",
    command: "update",
    prepare: async () => {
      const { id } = await seed("POST", `/organizations/${org()}/groups`, {
        slug: `receipt-${createId()}`,
        name: "Receipt",
      });
      const path = `/organizations/${org()}/groups/${id}`;
      return {
        method: "PATCH",
        path,
        body: { name: "Changed" },
        status: 200,
        changed: { body: { name: "Different" } },
        precondition: path,
        noop: {},
      };
    },
  },
  {
    family: "group",
    command: "erase",
    prepare: async () => {
      const { id } = await seed("POST", `/organizations/${org()}/groups`, {
        slug: `receipt-${createId()}`,
        name: "Receipt",
      });
      const other = createId();
      return {
        method: "DELETE",
        path: `/organizations/${org()}/groups/${id}?confirm=${id}`,
        status: 204,
        changed: {
          path: `/organizations/${org()}/groups/${other}?confirm=${other}`,
        },
      };
    },
  },
  {
    family: "member",
    command: "update",
    actor: "tenantAdmin",
    prepare: async () => {
      const path = await member();
      return {
        method: "PATCH",
        path,
        body: { validUntil: future },
        status: 200,
        changed: { body: { validUntil: "2099-01-01T00:00:00.000Z" } },
        precondition: `${path}/configuration`,
        noop: {},
      };
    },
  },
  {
    family: "member",
    command: "remove",
    actor: "tenantAdmin",
    prepare: async () => {
      const path = await member();
      return {
        method: "DELETE",
        path,
        status: 204,
        changed: { path: `/organizations/${org()}/members/${createId()}` },
      };
    },
  },
  {
    family: "client",
    command: "create",
    prepare: async () => {
      const body = {
        clientId: createId(),
        name: "Receipt",
        organizationId: org(),
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["write", "read"],
      };
      return {
        method: "POST",
        path: "/clients",
        body,
        status: 201,
        equivalent: [
          {
            ...body,
            redirectUris: [],
            clientCredentialsScopes: ["read", "write", "read"],
          },
        ],
        changed: { body: { ...body, name: "Different" } },
      };
    },
  },
  {
    family: "client",
    command: "update",
    prepare: async () => {
      const { clientId } = await seed("POST", "/clients", {
        clientId: createId(),
        name: "Receipt",
        organizationId: org(),
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["read"],
      });
      return {
        method: "PATCH",
        path: `/clients/${clientId}`,
        body: { name: "Changed" },
        status: 200,
        changed: { body: { name: "Different" } },
        precondition: `/clients/${clientId}`,
        noop: {},
      };
    },
  },
  {
    family: "client",
    command: "erase",
    prepare: async () => {
      const { clientId } = await seed("POST", "/clients", {
        clientId: createId(),
        name: "Receipt",
        organizationId: org(),
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["read"],
      });
      return {
        method: "DELETE",
        path: `/clients/${clientId}?confirm=${clientId}`,
        status: 204,
        changed: { path: `/clients/${clientId}?confirm=different` },
      };
    },
  },
  {
    family: "resource",
    command: "create",
    prepare: async () => {
      const body = {
        identifier: `https://${createId()}.example/resource`,
        name: "Receipt",
        allowedScopes: ["write", "read", "read"],
      };
      return {
        method: "POST",
        path: "/resources",
        body,
        status: 201,
        // Omitted and explicit shared defaults, and set order, normalise alike.
        equivalent: [
          { ...body, allowedScopes: ["read", "write"] },
          {
            ...body,
            classification: "platform_shared",
            organizationId: null,
          },
        ],
        changed: {
          body: {
            ...body,
            classification: "tenant_owned",
            organizationId: org(),
          },
        },
      };
    },
  },
  {
    family: "resource",
    command: "update",
    prepare: async () => {
      const path = `/resources/${encodeURIComponent(await resource())}`;
      return {
        method: "PATCH",
        path,
        body: { name: "Changed" },
        status: 200,
        changed: { body: { name: "Different" } },
        precondition: path,
        noop: {},
      };
    },
  },
  {
    family: "resource",
    command: "erase",
    prepare: async () => {
      const identifier = await resource();
      const other = `https://${createId()}.example/resource`;
      const path = `/resources/${encodeURIComponent(identifier)}`;
      return {
        method: "DELETE",
        path: `${path}?${new URLSearchParams({ confirm: identifier })}`,
        status: 204,
        changed: {
          path: `/resources/${encodeURIComponent(other)}?${new URLSearchParams({ confirm: other })}`,
        },
      };
    },
  },
  {
    family: "entitlement",
    command: "create",
    prepare: async () => {
      const target = await resource();
      return {
        method: "POST",
        path: `/organizations/${org()}/entitlements`,
        body: { resource: target, scopes: ["write", "read", "read"] },
        status: 201,
        equivalent: [{ resource: target, scopes: ["read", "write"] }],
        changed: { body: { resource: target, scopes: ["read"] } },
      };
    },
  },
  {
    family: "entitlement",
    command: "update",
    prepare: async () => {
      const { id } = await seed(
        "POST",
        `/organizations/${org()}/entitlements`,
        { resource: await resource(), scopes: ["read"] },
      );
      const path = `/organizations/${org()}/entitlements/${id}`;
      return {
        method: "PATCH",
        path,
        body: { scopes: ["write"], validUntil: future },
        status: 200,
        changed: { body: { scopes: ["read"] } },
        precondition: path,
        noop: {},
      };
    },
  },
  {
    family: "entitlement",
    command: "remove",
    prepare: async () => {
      const { id } = await seed(
        "POST",
        `/organizations/${org()}/entitlements`,
        { resource: await resource(), scopes: ["read"] },
      );
      return {
        method: "DELETE",
        path: `/organizations/${org()}/entitlements/${id}`,
        status: 204,
        changed: {
          path: `/organizations/${org()}/entitlements/${createId()}`,
        },
      };
    },
  },
  {
    family: "user",
    command: "disable",
    prepare: async () => {
      const { id } = await person();
      return {
        method: "POST",
        path: `/users/${id}/disable`,
        status: 200,
        changed: { path: `/users/${createId()}/disable` },
        noop: {},
      };
    },
  },
  {
    family: "user",
    command: "erase",
    prepare: async () => {
      const { id } = await person();
      return {
        method: "DELETE",
        path: `/users/${id}?confirm=${id}`,
        status: 204,
        changed: { path: `/users/${id}?confirm=${createId()}` },
      };
    },
  },
  {
    family: "sessions",
    command: "revoke all",
    prepare: async () => {
      const { id } = await person(true);
      return {
        method: "DELETE",
        path: `/users/${id}/sessions`,
        status: 200,
        changed: { path: `/users/${createId()}/sessions` },
        noop: {},
      };
    },
  },
  {
    family: "session",
    command: "revoke one",
    prepare: async () => {
      const { id, sessionId } = await person(true);
      return {
        method: "DELETE",
        path: `/users/${id}/sessions/${sessionId}`,
        status: 204,
        changed: { path: `/users/${id}/sessions/${createId()}` },
      };
    },
  },
  {
    family: "domain",
    command: "create",
    prepare: async () => {
      const domain = `receipt-${createId()}.example.com`;
      return {
        method: "POST",
        path: `/organizations/${org()}/domains`,
        body: { domain: ` ${domain.toUpperCase()} ` },
        status: 201,
        equivalent: [{ domain }],
        changed: { body: { domain: `other-${domain}` } },
      };
    },
  },
  {
    family: "domain",
    command: "disable",
    prepare: async () => {
      const { id } = await seed("POST", `/organizations/${org()}/domains`, {
        domain: `receipt-${createId()}.example.com`,
      });
      return {
        method: "POST",
        path: `/organizations/${org()}/domains/${id}/disable`,
        status: 200,
        changed: {
          path: `/organizations/${org()}/domains/${createId()}/disable`,
        },
        noop: {},
      };
    },
  },
  {
    family: "domain",
    command: "delete",
    prepare: async () => {
      const { id } = await seed("POST", `/organizations/${org()}/domains`, {
        domain: `receipt-${createId()}.example.com`,
      });
      return {
        method: "DELETE",
        path: `/organizations/${org()}/domains/${id}`,
        status: 204,
        changed: { path: `/organizations/${org()}/domains/${createId()}` },
      };
    },
  },
  {
    family: "sso provider",
    command: "put",
    prepare: async () => {
      const target = await ssoOrganization();
      const path = `/organizations/${target.id}/sso-provider`;
      const body = {
        ...sso,
        domain: ` ${target.domain.toUpperCase()} `,
        oidc: { ...sso.oidc, scopes: ["profile", "openid", "profile"] },
      };
      return {
        method: "PUT",
        path,
        body,
        status: 201,
        equivalent: [
          {
            ...body,
            domain: target.domain,
            oidc: { ...sso.oidc, scopes: ["openid", "profile"] },
          },
        ],
        // The secret is part of the fingerprint without being stored in it.
        changed: {
          body: { ...body, oidc: { ...body.oidc, clientSecret: "different" } },
        },
        precondition: path,
        noop: {
          body: {
            ...body,
            oidc: { clientId: sso.oidc.clientId, scopes: body.oidc.scopes },
          },
        },
      };
    },
  },
  {
    family: "sso provider",
    command: "delete",
    prepare: async () => {
      const target = await ssoOrganization();
      const path = `/organizations/${target.id}/sso-provider`;
      await seed("PUT", path, { ...sso, domain: target.domain });
      return {
        method: "DELETE",
        path,
        status: 204,
        changed: {
          path: `/organizations/${fixture.outsider.organizationId}/sso-provider`,
        },
      };
    },
  },
  {
    family: "capability",
    command: "create",
    prepare: async () => {
      const body = await capability();
      return {
        method: "POST",
        path: `/organizations/${org()}/capabilities`,
        body,
        status: 201,
        changed: { body: { ...body, scopes: ["read"] } },
      };
    },
  },
  {
    family: "capability",
    command: "update",
    prepare: async () => {
      const { id } = await seed(
        "POST",
        `/organizations/${org()}/capabilities`,
        await capability(),
      );
      const path = `/organizations/${org()}/capabilities/${id}`;
      return {
        method: "PATCH",
        path,
        body: { status: "disabled" },
        status: 200,
        changed: { body: { scopes: ["read"] } },
        precondition: path,
        noop: {},
      };
    },
  },
  {
    family: "capability",
    command: "remove",
    prepare: async () => {
      const { id } = await seed(
        "POST",
        `/organizations/${org()}/capabilities`,
        await capability(),
      );
      return {
        method: "DELETE",
        path: `/organizations/${org()}/capabilities/${id}`,
        status: 204,
        changed: {
          path: `/organizations/${org()}/capabilities/${createId()}`,
        },
      };
    },
  },
];

async function prepare(row: Row) {
  const command = await row.prepare();
  const actor = row.actor ?? "platformAdmin";
  const key = createId();
  const precondition = async () => {
    const response = await fixture.app.request(
      `/api/admin/v1${command.precondition}`,
      { headers: fixture.headers(actor) },
    );
    return response.status === 404 ? "*" : response.headers.get("ETag")!;
  };
  // Retries keep the first precondition, which is stale once committed.
  const tag = command.precondition ? await precondition() : undefined;
  const send = async (
    input: { path?: string; body?: unknown; key?: string } = {},
  ) => {
    const headers = fixture.headers(actor);
    headers.set("Idempotency-Key", input.key ?? key);
    if (command.precondition) {
      const value = input.key ? await precondition() : tag!;
      headers.set(value === "*" ? "If-None-Match" : "If-Match", value);
    }
    const body = Object.hasOwn(input, "body") ? input.body : command.body;
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return fixture.app.request(`/api/admin/v1${input.path ?? command.path}`, {
      method: command.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const reservations = () =>
    fixture.db
      .select()
      .from(adminOperations)
      .where(
        and(
          eq(
            adminOperations.actorInstance,
            `user:${fixture.principals[actor].userId}`,
          ),
          eq(
            adminOperations.keyDigest,
            createHash("sha256").update(key).digest("hex"),
          ),
        ),
      );
  return { command, actor, send, reservations };
}
const firstOfFamily = rows.filter(
  (row, index) =>
    rows.findIndex((other) => other.family === row.family) === index,
);
const label = (row: Row) => `${row.family} ${row.command}`;

test.each(rows.map((row) => [label(row), row] as const))(
  "%s: matching retries return a receipt, changed input conflicts and current authority is required",
  async (_, row) => {
    const { command, actor, send, reservations } = await prepare(row);
    const first = await send();
    expect(first.status).toBe(command.status);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("access-control-expose-headers")).toContain(
      "Operation-Id",
    );
    const operationId = first.headers.get("Operation-Id")!;
    const [operation] = await reservations();
    expect(operation).toMatchObject({
      id: operationId,
      outcome: "applied",
      authorityScope: actor === "tenantAdmin" ? `tenant:${org()}` : "platform",
    });
    const evidence = () =>
      fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId));
    const before = await evidence();
    expect(before.length).toBeGreaterThan(0);
    for (const value of privateValues)
      expect(JSON.stringify(before)).not.toContain(value);
    const traced = await fixture.app.request(
      `/api/admin/v1/audit-events?operationId=${operationId}`,
      { headers: fixture.headers("platformReader") },
    );
    expect(
      (await traced.json()).items.map((event: { id: string }) => event.id),
    ).toEqual(
      before
        .map((event) => event.id)
        .sort()
        .reverse(),
    );
    for (const body of [command.body, ...(command.equivalent ?? [])])
      await expectReceipt(fixture.db, await send({ body }));
    expect(await evidence()).toEqual(before);
    expect(await reservations()).toHaveLength(1);
    const changed = await send(command.changed);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "idempotency_key_reused",
      retryable: false,
    });
    if (command.noop) {
      const again = await send({
        key: createId(),
        body: Object.hasOwn(command.noop, "body")
          ? command.noop.body
          : command.body,
      });
      expect(again.status).toBeLessThan(300);
      const [receipt] = await fixture.db
        .select()
        .from(adminOperations)
        .where(eq(adminOperations.id, again.headers.get("Operation-Id")!));
      expect(receipt?.outcome).toBe("noop");
    }
    const memberId = fixture.principals[actor].memberId;
    const original = fixture.appDb.transaction.bind(fixture.appDb);
    fixture.appDb.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, memberId));
      return original(...args);
    }) as typeof original);
    try {
      const denied = await send();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    } finally {
      fixture.appDb.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, memberId));
    }
    expect(await evidence()).toEqual(before);
  },
);

// Member admission locks its user before reaching the operation reservation.
// Its real overlapping-removal case remains in members.integration.test.ts.
test.each(
  firstOfFamily
    .filter((row) => row.family !== "member")
    .map((row) => [label(row), row] as const),
)(
  "%s: overlapping same-key commands commit once and return one 409",
  async (_, row) => {
    const { command, send, reservations } = await prepare(row);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fixture.appDb.transaction.bind(fixture.appDb);
    fixture.appDb.transaction = afterBrokerRead(original, (async (
      callback: Parameters<typeof original>[0],
    ) => {
      fixture.appDb.transaction = original;
      return original(async (tx) => {
        const result = await callback(tx);
        ready.resolve();
        await release.promise;
        return result;
      });
    }) as typeof original);
    const first = send();
    try {
      await Promise.race([
        ready.promise,
        first.then(() => {
          throw new Error("Command did not reach commit barrier");
        }),
      ]);
      const second = await send();
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        code: "operation_in_progress",
        retryable: true,
      });
    } finally {
      fixture.appDb.transaction = original;
      release.resolve();
    }
    expect((await first).status).toBe(command.status);
    expect(await reservations()).toHaveLength(1);
    await expectReceipt(fixture.db, await send());
  },
);

test.each(firstOfFamily.map((row) => [label(row), row] as const))(
  "%s: failed commands leave no receipt and the same key remains usable",
  async (_, row) => {
    const { command, send, reservations } = await prepare(row);
    await fixture.db.execute(
      sql`alter table audit_events add constraint receipt_fault check (operation_id is null) not valid`,
    );
    try {
      expect((await send()).status).toBe(400);
      expect(await reservations()).toEqual([]);
    } finally {
      await fixture.db.execute(
        sql`alter table audit_events drop constraint receipt_fault`,
      );
    }
    expect((await send()).status).toBe(command.status);
    expect(await reservations()).toHaveLength(1);
    await expectReceipt(fixture.db, await send());
  },
);

test("a missing or over-long key is refused before any reservation", async () => {
  const before = await fixture.db.select().from(adminOperations);
  for (const key of [undefined, "x".repeat(257)]) {
    const headers = fixture.headers("platformAdmin");
    if (key === undefined) headers.delete("Idempotency-Key");
    else headers.set("Idempotency-Key", key);
    const response = await fixture.app.request(
      `/api/admin/v1/users/${createId()}/sessions`,
      { method: "DELETE", headers },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_idempotency_key",
    });
  }
  expect(await fixture.db.select().from(adminOperations)).toEqual(before);
});
