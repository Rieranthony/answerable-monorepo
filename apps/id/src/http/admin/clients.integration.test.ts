import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents, oauthAccessTokens } from "../../db/schema/index.ts";
import { findClient } from "../../__tests__/client-queries.ts";
import { hashClientSecret } from "../../services/client-secrets.ts";
import { createId } from "../../lib/id.ts";
import { routes, clientSchema } from "./clients.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture, {
  params: () => ({
    clientId: fixture.platform.client.clientId,
    resource: encodeURIComponent(fixture.platform.adminResource),
  }),
});
async function request(
  path = "",
  method = "GET",
  body?: unknown,
  kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("x-request-id", "clients-http-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method === "PATCH") {
    const current = await fixture.app.request(`/api/admin/v1/clients${path}`, {
      headers,
    });
    headers.set(
      "If-Match",
      current.headers.get("ETag") ?? '"00000000-0000-7000-8000-000000000000:1"',
    );
  }
  return fixture.app.request(`/api/admin/v1/clients${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function mint(clientId: string, secret: string, resource: string) {
  return fixture.app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource,
      scope: "tutor:read",
    }),
  });
}
for (const machine of [false, true])
  test(`${machine ? "machine" : "platformAdmin"} manages a client through real token minting, rotation and revocation`, async () => {
    const kind = machine
      ? { bearer: await fixture.mintMachineToken() }
      : "platformAdmin";
    const resource = `https://${machine ? "machine" : "human"}.clients.example/mcp`;
    const headers = fixture.headers(kind);
    headers.set("content-type", "application/json");
    expect(
      (
        await fixture.app.request("/api/admin/v1/resources", {
          method: "POST",
          headers,
          body: JSON.stringify({
            identifier: resource,
            name: "MCP",
            allowedScopes: ["tutor:read"],
          }),
        })
      ).status,
    ).toBe(201);
    const created = await request(
      "",
      "POST",
      {
        clientId: machine ? "machine-http" : "human-http",
        name: "Example cell",
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["tutor:read"],
        organizationId: fixture.tenant.organizationId,
      },
      kind,
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    const client = clientSchema.parse(body);
    expect(client.hasClientSecret).toBe(true);
    const secret = body.clientSecret as string;
    expect(secret).toBeString();
    const path = "/" + client.clientId;
    const link = path + "/resources/" + encodeURIComponent(resource);
    const get = await request(path, "GET", undefined, kind);
    expect(get.status).toBe(200);
    expect(await get.json()).not.toHaveProperty("clientSecret");
    const pageResponse = await request(
      `?q=${client.clientId}&organizationId=${fixture.tenant.organizationId}&disabled=false`,
      "GET",
      undefined,
      kind,
    );
    expect(pageResponse.status).toBe(200);
    const page = await pageResponse.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("clientSecret");
    expect(
      (await request(path, "PATCH", { name: "Renamed" }, kind)).status,
    ).toBe(200);
    expect((await request(link, "PUT", undefined, kind)).status).toBe(201);
    const existingLink = await request(link, "PUT", undefined, kind);
    expect(existingLink.status).toBe(200);
    expect(await existingLink.json()).toEqual({ created: false });
    const approval = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/capabilities`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: client.clientId,
          resource,
          grantKind: "client_credentials",
          scopes: ["tutor:read"],
        }),
      },
    );
    expect(approval.status).toBe(201);
    const minted = await mint(client.clientId, secret, resource);
    expect(minted.status).toBe(200);
    expect(decodeJwt((await minted.json()).access_token).aud).toBe(resource);
    const rotated = await request(
      path + "/rotate-secret",
      "POST",
      undefined,
      kind,
    );
    expect(rotated.status).toBe(200);
    const newSecret = (await rotated.json()).clientSecret as string;
    expect(newSecret).not.toBe(secret);
    const old = await mint(client.clientId, secret, resource);
    expect(old.status).toBe(401);
    expect(await old.json()).toMatchObject({ error: "invalid_client" });
    expect((await mint(client.clientId, newSecret, resource)).status).toBe(200);
    // JWT issuance need not persist an access row; seed an opaque token to prove revocation.
    const tokenId = createId();
    await fixture.db.insert(oauthAccessTokens).values({
      id: tokenId,
      token: createId(),
      clientId: client.clientId,
      scopes: ["tutor:read"],
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(
      (await request(path + "/disable", "POST", undefined, kind)).status,
    ).toBe(200);
    expect((await mint(client.clientId, newSecret, resource)).status).toBe(401);
    expect(
      (
        await fixture.db
          .select()
          .from(oauthAccessTokens)
          .where(eq(oauthAccessTokens.id, tokenId))
      )[0]?.revoked,
    ).toBeInstanceOf(Date);
    expect(
      (await request(path + "/enable", "POST", undefined, kind)).status,
    ).toBe(200);
    expect((await mint(client.clientId, newSecret, resource)).status).toBe(200);
    expect((await request(link, "DELETE", undefined, kind)).status).toBe(204);
    const unlinked = await mint(client.clientId, newSecret, resource);
    expect(unlinked.status).toBeGreaterThanOrEqual(400);
    expect(unlinked.status).toBeLessThan(500);
    expect((await unlinked.json()).error).toBeString();
    expect((await request(link, "PUT", undefined, kind)).status).toBe(201);
    expect((await mint(client.clientId, newSecret, resource)).status).toBe(200);
    for (const organizationId of [fixture.platform.organizationId, null]) {
      const response = await request(
        path + "/owner",
        "PUT",
        { organizationId },
        kind,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "ownership_conflict",
      });
    }
    const unchanged = await request(
      path + "/owner",
      "PUT",
      { organizationId: fixture.tenant.organizationId },
      kind,
    );
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({
      organizationId: fixture.tenant.organizationId,
    });
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "client"),
          eq(auditEvents.targetId, client.clientId),
        ),
      )
      .orderBy(auditEvents.id);
    expect(events.map((e) => e.action)).toEqual([
      "client.created",
      "client.updated",
      "client.resource_linked",
      "client.resource_unchanged",
      "client.secret_rotated",
      "client.grants_revoked",
      "client.disabled",
      "client.enabled",
      "client.resource_unlinked",
      "client.resource_linked",
      "client.owner_unchanged",
    ]);
    for (const event of events)
      expect(event).toMatchObject({
        actorType: machine ? "client" : "user",
        actorId: machine
          ? fixture.platform.client.clientId
          : fixture.principals.platformAdmin.userId,
        requestId: "clients-http-test",
      });
    for (const value of [
      secret,
      newSecret,
      hashClientSecret(secret),
      hashClientSecret(newSecret),
      "clientSecret",
    ])
      expect(JSON.stringify(events)).not.toContain(value);
  });
test("private key and public clients work through both admin credentials", async () => {
  for (const kind of [
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ] as const) {
    const privateResponse = await request(
      "",
      "POST",
      {
        name: "Private",
        tokenEndpointAuthMethod: "private_key_jwt",
        grantTypes: ["client_credentials"],
        organizationId: fixture.tenant.organizationId,
        clientCredentialsScopes: ["tutor:read"],
        jwksUri: "https://app.example/jwks",
      },
      kind,
    );
    expect(privateResponse.status).toBe(201);
    const privateClient = await privateResponse.json();
    expect(privateClient.hasClientSecret).toBe(false);
    expect(privateClient).not.toHaveProperty("clientSecret");
    expect(
      (
        await request(
          `/${privateClient.clientId}/rotate-secret`,
          "POST",
          undefined,
          kind,
        )
      ).status,
    ).toBe(409);
    const publicResponse = await request(
      "",
      "POST",
      {
        name: "Public",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://app.example/callback"],
      },
      kind,
    );
    expect(publicResponse.status).toBe(201);
    const publicClient = await publicResponse.json();
    expect(publicClient).toMatchObject({
      requirePKCE: true,
      hasClientSecret: false,
      responseTypes: ["code"],
    });
    expect(publicClient).not.toHaveProperty("clientSecret");
    expect(
      (await findClient(fixture.db, publicClient.clientId))?.clientSecret,
    ).toBeNull();
  }
});
test("client cross-field failures include errors; the create example reaches an unknown organisation's 404", async () => {
  const example = routes.createClient.example.body;
  const unknown = await request("", "POST", example);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ code: "not_found" });
  const input = { ...example, organizationId: fixture.tenant.organizationId };
  for (const patch of [
    { tokenEndpointAuthMethod: "none" },
    { clientCredentialsScopes: [] },
    { organizationId: undefined },
    { grantTypes: ["authorization_code"], redirectUris: [] },
    { tokenEndpointAuthMethod: "private_key_jwt" },
    {
      tokenEndpointAuthMethod: "private_key_jwt",
      jwks: "{}",
      jwksUri: "https://app.example/jwks",
    },
    { tokenEndpointAuthMethod: "private_key_jwt", jwks: "bad" },
    { redirectUris: ["not-a-uri"] },
    { contacts: ["invalid"] },
    { clientId: "Bad_ID" },
  ]) {
    const response = await request("", "POST", { ...input, ...patch });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "validation_failed",
      errors: expect.any(Array),
    });
  }
  const response = await request("", "POST", {
    ...input,
    clientId: "conflicts",
  });
  expect(response.status).toBe(201);
  const duplicate = await request("", "POST", {
    ...input,
    clientId: "conflicts",
  });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "conflict" });
  for (const patch of [{}, { clientCredentialsScopes: [] }]) {
    const invalid = await request("/conflicts", "PATCH", patch);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "validation_failed",
      errors: expect.any(Array),
    });
  }
  expect(
    (await request("/conflicts/owner", "PUT", { organizationId: createId() }))
      .status,
  ).toBe(409);
  expect(
    (
      await request(
        "/conflicts/resources/" + encodeURIComponent("https://none.example"),
        "PUT",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        "/conflicts/resources/" +
          encodeURIComponent(fixture.platform.adminResource),
        "DELETE",
      )
    ).status,
  ).toBe(204);
  expect((await request("/conflicts/enable", "POST")).status).toBe(200);
  expect((await request("/conflicts/disable", "POST")).status).toBe(200);
  expect((await request("/conflicts/disable", "POST")).status).toBe(200);
  const disabled = await (await request("?q=conflicts&disabled=true")).json();
  expect(disabled.items).toHaveLength(1);
});
test("client cursor pages have no gaps and do not expose digests", async () => {
  const ids: string[] = [];
  for (const name of ["one", "two", "three"]) {
    const response = await request("", "POST", {
      name: `Pagination ${name}`,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      redirectUris: ["https://app.example/callback"],
    });
    expect(response.status).toBe(201);
    ids.push((await response.json()).id);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      "?q=Pagination&limit=1" + (cursor ? "&cursor=" + cursor : ""),
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    for (const row of page.items)
      expect(row).not.toHaveProperty("clientSecret");
    seen.push(...page.items.map((r: { id: string }) => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(ids.reverse());
});
