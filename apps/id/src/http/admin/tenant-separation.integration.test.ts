import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { approveMachineCapability } from "../../__tests__/capabilities.ts";
import { platformWriteService } from "../../__tests__/platform-context.ts";
import { createResource } from "../../__tests__/resource-queries.ts";
import {
  auditEvents,
  organizationCapabilities,
  organizationDomains,
  sessions,
  ssoProviders,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import * as clients from "../../services/clients.ts";
import { adminRouteTables } from "./index.ts";
import type { AdminRoute } from "./route-table.ts";

const createClient = platformWriteService(clients.createClient);
const linkResource = platformWriteService(clients.linkResource);

// Tenant A is the fixture's tenant and B its outsider. One tenant-A machine
// bearer, holding every tenant scope, asks for B's rows by every route.
let fixture: AdminFixture;
let bearer: string;
let a: Record<string, string>;
let b: Record<string, string>;
let identifiersOfB: string[];

beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
  const metadata = { requestId: "tenant-separation" };
  const children = async (
    organizationId: string,
    principal: "tenantReader" | "outsider",
    name: string,
  ) => {
    const { memberId, userId } = fixture.principals[principal];
    const resource = await createResource(fixture.db, {
      identifier: `https://${name}-${createId()}.example/private`,
      name: `${name} private`,
      allowedScopes: ["read"],
      classification: "tenant_owned",
      organizationId,
    });
    const client = await createClient(fixture.db, metadata, {
      clientId: `${name}-app-${createId()}`,
      name: `${name} app`,
      organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [`https://${name}-app.example/callback`],
      scopes: ["openid", "read"],
    });
    await linkResource(
      fixture.db,
      metadata,
      client.clientId,
      resource.identifier,
    );
    const post = async (path: string, body: unknown, method = "POST") => {
      const headers = fixture.headers("platformAdmin");
      headers.set("Content-Type", "application/json");
      const response = await fixture.app.request(
        `/api/admin/v1/organizations/${organizationId}${path}`,
        { method, headers, body: JSON.stringify(body) },
      );
      expect(response.status).toBeLessThan(300);
      return {
        id: ((await response.json()) as { id: string }).id,
        operationId: response.headers.get("Operation-Id")!,
      };
    };
    const group = await post("/groups", { slug: name, name });
    const assignment = await post(
      `/groups/${group.id}/members/${memberId}`,
      {},
      "PUT",
    );
    const entitlement = await post("/entitlements", {
      groupId: group.id,
      resource: resource.identifier,
      scopes: ["read"],
    });
    const [capability] = await fixture.db
      .select({ id: organizationCapabilities.id })
      .from(organizationCapabilities)
      .where(eq(organizationCapabilities.organizationId, organizationId));
    const [domain] = await fixture.db
      .select({
        id: organizationDomains.id,
        domain: organizationDomains.domain,
      })
      .from(organizationDomains)
      .where(
        and(
          eq(organizationDomains.organizationId, organizationId),
          isNull(organizationDomains.deletedAt),
        ),
      );
    const [provider] = await fixture.db
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, organizationId));
    const [session] = await fixture.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    const [event] = await fixture.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId));
    return {
      organizationId,
      memberId,
      userId,
      sessionId: session!.id,
      groupId: group.id,
      operationId: group.operationId,
      groupMemberId: assignment.id,
      entitlementId: entitlement.id,
      capabilityId: capability!.id,
      domainId: domain!.id,
      domain: domain!.domain,
      providerId: provider!.id,
      clientId: client.clientId,
      clientInstanceId: client.id,
      resource: resource.identifier,
      resourceInstanceId: resource.id,
      auditEventId: event!.id,
    };
  };
  a = await children(fixture.tenant.organizationId, "tenantReader", "a");
  b = await children(fixture.outsider.organizationId, "outsider", "b");
  const events = await fixture.db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, b.organizationId!));
  identifiersOfB = [
    ...new Set([
      ...Object.values(b),
      "outsider@outsider.example.com",
      ...events.map((event) => event.id),
    ]),
  ];
  const machine = await createClient(fixture.db, metadata, {
    clientId: `a-machine-${createId()}`,
    name: "Tenant A machine",
    organizationId: a.organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    clientCredentialsScopes: ["org:read", "org:users"],
  });
  await linkResource(
    fixture.db,
    metadata,
    machine.clientId,
    fixture.platform.adminResource,
  );
  await approveMachineCapability(fixture.db, {
    organizationId: a.organizationId!,
    clientId: machine.clientId,
    resource: fixture.platform.adminResource,
    scopes: ["org:read", "org:users"],
  });
  const issued = await fixture.app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${machine.clientId}:${machine.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "org:read org:users",
      resource: fixture.platform.adminResource,
    }),
  });
  expect(issued.status).toBe(200);
  bearer = ((await issued.json()) as { access_token: string }).access_token;
});

afterAll(async () => {
  await fixture?.close();
});

const routes = () => adminRouteTables.flatMap((table) => Object.values(table));
const parameters = (route: AdminRoute) =>
  [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!);

/** Every route's example request, its path filled from `ids`. */
async function call(route: AdminRoute, ids: Record<string, string>) {
  const path = route.path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = ids[name];
    if (value === undefined)
      throw new Error(`No ${name} for ${route.operationId}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams(route.example?.query);
  if (route.kind === "erase")
    search.set("confirm", decodeURIComponent(path.split("/").at(-1)!));
  const url = `${path}${search.size ? `?${search}` : ""}`;
  const headers = fixture.headers({ bearer });
  if (route.parameters?.some((p) => "name" in p && p.name === "If-Match"))
    headers.set("If-Match", `"${ids.memberId}:1"`);
  const body = route.example?.body ?? (route.requestBody ? {} : undefined);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fixture.app.request(`/api/admin/v1${url}`, {
    method: route.method.toUpperCase(),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const sent = decodeURIComponent(url);
  return {
    request: `${route.method.toUpperCase()} ${url}`,
    status: response.status,
    leaked: identifiersOfB.filter(
      (value) => text.includes(value) && !sent.includes(value),
    ),
  };
}

const tenantRoutes = () =>
  routes().filter(
    (route) =>
      route.orgScope !== undefined && route.path.includes(":organizationId"),
  );

test("tenant routes answer 404 for another tenant's organisation and its rows", async () => {
  const results = [];
  for (const route of tenantRoutes()) results.push(await call(route, b));
  expect(results.length).toBeGreaterThan(20);
  expect(
    results.filter((result) => result.status !== 404 || result.leaked.length),
  ).toEqual([]);
});

test("tenant routes answer 404 for one of another tenant's rows under the caller's organisation", async () => {
  const results = [];
  for (const route of tenantRoutes())
    for (const name of parameters(route).filter(
      (name) => name !== "organizationId",
    ))
      results.push(await call(route, { ...a, [name]: b[name]! }));
  expect(results.length).toBeGreaterThan(10);
  expect(
    results.filter((result) => result.status !== 404 || result.leaked.length),
  ).toEqual([]);
});

test("platform routes refuse a tenant bearer", async () => {
  const results = [];
  for (const route of routes().filter(
    (route) => !route.orgScope && !route.open,
  ))
    results.push(await call(route, b));
  expect(results.length).toBeGreaterThan(50);
  expect(
    results.filter((result) => result.status !== 403 || result.leaked.length),
  ).toEqual([]);
});
