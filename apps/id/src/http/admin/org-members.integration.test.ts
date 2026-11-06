import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { approveMachineCapability } from "../../__tests__/capabilities.ts";
import { platformWriteService } from "../../__tests__/platform-context.ts";
import {
  groupMembers,
  groups,
  oauthClients,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import * as clientsImplementation from "../../services/clients.ts";
import { adminRouteTables } from "./index.ts";
import type { AdminRoute } from "./route-table.ts";
import { adminScopes } from "./scopes.ts";

// org:members: a machine client of one organisation reads its members and its group names, and nothing else.
const clients = {
  createClient: platformWriteService(clientsImplementation.createClient),
  linkResource: platformWriteService(clientsImplementation.linkResource),
};
let fixture: AdminFixture;
let groupId: string;
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
  groupId = createId();
  await fixture.db.insert(groups).values({
    id: groupId,
    organizationId: fixture.tenant.organizationId,
    slug: "project-admins",
    name: "Project admins",
  });
  await fixture.db.insert(groupMembers).values({
    id: createId(),
    organizationId: fixture.tenant.organizationId,
    groupId,
    memberId: fixture.principals.tenantAdmin.memberId,
  });
});
afterAll(async () => {
  await fixture?.close();
});

/** A tenant machine client with `clientScopes`, approved for `capabilityScopes`. */
async function machineClient(
  clientScopes: string[],
  capabilityScopes = clientScopes,
) {
  const client = await clients.createClient(
    fixture.db,
    { requestId: "org-members-setup" },
    {
      clientId: `directory-${createId()}`,
      name: "Directory reader",
      organizationId: fixture.tenant.organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      redirectUris: [],
      clientCredentialsScopes: clientScopes,
    },
  );
  await clients.linkResource(
    fixture.db,
    { requestId: "org-members-setup" },
    client.clientId,
    fixture.platform.adminResource,
  );
  await approveMachineCapability(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    clientId: client.clientId,
    resource: fixture.platform.adminResource,
    scopes: capabilityScopes,
  });
  return {
    clientId: client.clientId,
    token: (scope: string) =>
      fixture.app.request("/auth/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope,
          resource: fixture.platform.adminResource,
        }),
      }),
  };
}
async function bearer(scope: string, clientScopes = [scope]) {
  const response = await (await machineClient(clientScopes)).token(scope);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
function call(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  organizationId = fixture.tenant.organizationId,
) {
  const headers = fixture.headers({ bearer: token });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "POST")
    headers.set("If-Match", '"00000000-0000-7000-8000-000000000000:1"');
  return fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}${path}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
type Page = { items: Record<string, unknown>[] };

test("a machine client of firm A with org:members lists firm A's members, with user id, email, name and effective", async () => {
  const response = await call(await bearer("org:members"), "/members");
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as Page;
  expect(items.length).toBeGreaterThan(0);
  expect(
    items.find((item) => item.id === fixture.principals.tenantAdmin.memberId),
  ).toMatchObject({
    userId: fixture.principals.tenantAdmin.userId,
    email: "tenantadmin@tenant.example.com",
    name: "tenantAdmin",
    effective: true,
  });
  expect(
    items.every(
      (item) => item.organizationId === fixture.tenant.organizationId,
    ),
  ).toBe(true);
});

test("the same client lists firm A's groups, with id, slug and name", async () => {
  const response = await call(await bearer("org:members"), "/groups");
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as Page;
  expect(items).toContainEqual(
    expect.objectContaining({
      id: groupId,
      slug: "project-admins",
      name: "Project admins",
      status: "active",
    }),
  );
  for (const item of items) expect(item).not.toHaveProperty("members");
});

test("the same client is refused firm B's members and groups, as not_found", async () => {
  const token = await bearer("org:members");
  for (const path of ["/members", "/groups"]) {
    const response = await call(
      token,
      path,
      "GET",
      undefined,
      fixture.outsider.organizationId,
    );
    expect(response.status, path).toBe(404);
  }
});

test("the same client is refused getMember, group members, domains, entitlements, capabilities and audit events of firm A", async () => {
  const token = await bearer("org:members");
  for (const path of [
    `/members/${fixture.principals.tenantAdmin.memberId}`,
    `/members/${fixture.principals.tenantAdmin.memberId}/access`,
    `/groups/${groupId}`,
    `/groups/${groupId}/members`,
    "/domains",
    "/entitlements",
    "/capabilities",
    "/audit-events",
    "/access?resource=https%3A%2F%2Fnone.example",
    "/sso-provider",
  ]) {
    const response = await call(token, path);
    expect(response.status, path).toBe(403);
  }
});

test("the same client is refused every write, import and member change", async () => {
  const token = await bearer("org:members");
  const memberId = fixture.principals.tenantReader.memberId;
  for (const [method, path, body] of [
    ["POST", "/groups", { slug: "intruders", name: "Intruders" }],
    ["POST", "/members/import", { addresses: ["new@tenant.example.com"] }],
    ["PATCH", `/members/${memberId}`, { validUntil: null }],
    ["DELETE", `/members/${memberId}`, undefined],
    ["PUT", `/groups/${groupId}/members/${memberId}`, {}],
  ] as const) {
    const response = await call(token, path, method, body);
    expect(response.status, `${method} ${path}`).toBe(403);
  }
  const listed = await call(token, `/groups`);
  expect(
    ((await listed.json()) as Page).items.some(
      (item) => item.slug === "intruders",
    ),
  ).toBe(false);
});

test("a user session and a machine client with org:read only still list members and groups", async () => {
  const token = await bearer("org:read");
  for (const path of ["/members", "/groups"]) {
    expect((await call(token, path)).status, path).toBe(200);
    const session = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}${path}`,
      { headers: fixture.headers("tenantReader") },
    );
    expect(session.status, path).toBe(200);
  }
});

test("org:users alone is still refused listMembers and listGroups", async () => {
  const token = await bearer("org:users");
  for (const path of ["/members", "/groups"]) {
    expect((await call(token, path)).status, path).toBe(403);
    const session = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}${path}`,
      { headers: fixture.headers("tenantUsersOnly") },
    );
    expect(session.status, path).toBe(403);
  }
});

const routes = () =>
  adminRouteTables.flatMap((table) => Object.values(table) as AdminRoute[]);

test("only listMembers and listGroups need org:members", () => {
  expect(
    routes()
      .filter((route) => route.orgScope === "org:members")
      .map((route) => route.operationId)
      .toSorted(),
  ).toEqual(["listGroups", "listMembers"]);
});

test("a machine client with org:members is refused every other admin route", async () => {
  const token = await bearer("org:members");
  const results: string[] = [];
  for (const route of routes()) {
    const path = route.path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
      name === "organizationId"
        ? fixture.tenant.organizationId
        : name === "resource"
          ? encodeURIComponent("https://none.example")
          : createId(),
    );
    const search = new URLSearchParams(route.example?.query);
    if (route.kind === "erase")
      search.set("confirm", decodeURIComponent(path.split("/").at(-1)!));
    const headers = fixture.headers({ bearer: token });
    if (route.parameters?.some((p) => "name" in p && p.name === "If-Match"))
      headers.set("If-Match", '"00000000-0000-7000-8000-000000000000:1"');
    const body = route.example?.body ?? (route.requestBody ? {} : undefined);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fixture.app.request(
      `/api/admin/v1${path}${search.size ? `?${search}` : ""}`,
      {
        method: route.method.toUpperCase(),
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const expected = route.open || route.orgScope === "org:members" ? 200 : 403;
    if (response.status !== expected)
      results.push(`${route.operationId}: ${response.status}`);
  }
  expect(results).toEqual([]);
});

test("a token loses org:members when the client's scopes no longer allow it", async () => {
  const client = await machineClient(["org:members"]);
  const response = await client.token("org:members");
  expect(response.status).toBe(200);
  const { access_token: token } = (await response.json()) as {
    access_token: string;
  };
  expect((await call(token, "/members")).status).toBe(200);
  await fixture.db
    .update(oauthClients)
    .set({ clientCredentialsScopes: ["org:users"] })
    .where(eq(oauthClients.clientId, client.clientId));
  expect([401, 403]).toContain((await call(token, "/members")).status);
});

test("a machine client holds org:members only when its token, its client scopes and the resource scopes all allow it", async () => {
  // Not in the client's scopes: no token.
  const outside = await machineClient(
    ["org:read"],
    ["org:read", "org:members"],
  );
  expect((await outside.token("org:members")).status).toBe(400);
  // In the client's scopes but not in the token: refused.
  const other = await bearer("org:users", ["org:members", "org:users"]);
  expect((await call(other, "/members")).status).toBe(403);
  // In the token, then taken out of the resource's scopes: refused.
  const token = await bearer("org:members");
  const reader = await bearer("org:read");
  expect((await call(token, "/members")).status).toBe(200);
  const resource = eq(
    oauthResources.identifier,
    fixture.platform.adminResource,
  );
  await fixture.db
    .update(oauthResources)
    .set({
      allowedScopes: adminScopes.filter((scope) => scope !== "org:members"),
    })
    .where(resource);
  try {
    expect((await call(token, "/members")).status).toBe(403);
    // An org:read token is refused too when the resource allows only org:members.
    await fixture.db
      .update(oauthResources)
      .set({ allowedScopes: ["platform:read", "org:members"] })
      .where(resource);
    expect((await call(reader, "/members")).status).toBe(403);
  } finally {
    await fixture.db
      .update(oauthResources)
      .set({ allowedScopes: [...adminScopes] })
      .where(resource);
  }
});
