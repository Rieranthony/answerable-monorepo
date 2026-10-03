import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { findClientPrincipal } from "../db/client-principal.ts";
import { organizationCapabilities, sessions } from "../db/schema/index.ts";
import type { BearerClaims, Principal } from "../http/principal.ts";
import { createId } from "../lib/id.ts";
import * as clients from "./clients.ts";
import { authorizeCommand } from "./command-authority.ts";

// The admin API checks authority in its middleware and again here, inside the
// command or read transaction. HTTP tests cannot tell which layer refused, so
// each in-transaction comparison is proven on its own below.
let fixture: AdminFixture;
let tenantClient: string;
beforeAll(async () => {
  fixture = await createAdminFixture();
  const client = await platformWriteService(clients.createClient)(
    fixture.db,
    { requestId: "command-authority" },
    {
      clientId: `tenant-${createId()}`,
      name: "Tenant machine",
      organizationId: fixture.tenant.organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      redirectUris: [],
      clientCredentialsScopes: ["org:users"],
    },
  );
  await platformWriteService(clients.linkResource)(
    fixture.db,
    { requestId: "command-authority" },
    client.clientId,
    fixture.platform.adminResource,
  );
  await approveMachineCapability(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    clientId: client.clientId,
    resource: fixture.platform.adminResource,
    scopes: ["org:users"],
  });
  tenantClient = client.clientId;
});
afterAll(async () => fixture?.close());

type Required = Parameters<typeof authorizeCommand>[3];
function authorize(
  principal: Principal,
  required: Required,
  claims?: BearerClaims,
  environment = fixture.environment,
) {
  return fixture.db.transaction((tx) =>
    authorizeCommand(tx, principal, environment, required, claims),
  );
}
async function user(name: "tenantAdmin"): Promise<Principal> {
  const { userId } = fixture.principals[name];
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return {
    type: "user",
    userId,
    email: "ignored",
    sessionId: session!.id,
    grants: [],
  };
}
/** Claims as the verifier would return them for a current token of this client. */
async function machine(clientId: string, scopes: string[]) {
  const row = (await findClientPrincipal(
    fixture.db,
    clientId,
    fixture.platform.adminResource,
  ))!;
  const principal: Principal = {
    type: "client",
    clientId,
    organizationId: row.organizationId!,
    grants: [],
  };
  const claims: BearerClaims = {
    expiresAt: Date.now() / 1000 + 300,
    clientInstance: row.id,
    organizationId: row.organizationId!,
    authorizationVersion: row.authorizationVersion,
    organizationAuthorizationVersion: row.organization!.authorizationVersion,
    clientId,
    scopes,
  };
  return { principal, claims };
}
const tenantUsers = (organizationId: string): Required => ({
  platform: "platform:users",
  tenant: { organizationId, scope: "org:users" },
});

test("a user's tenant grant admits only its own organisation", async () => {
  const principal = await user("tenantAdmin");
  expect(
    await authorize(principal, tenantUsers(fixture.tenant.organizationId)),
  ).toBe("tenant");
  await expect(
    authorize(principal, tenantUsers(fixture.outsider.organizationId)),
  ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
});

test("a tenant machine admits only its own organisation", async () => {
  const { principal, claims } = await machine(tenantClient, ["org:users"]);
  expect(
    await authorize(
      principal,
      tenantUsers(fixture.tenant.organizationId),
      claims,
    ),
  ).toBe("tenant");
  await expect(
    authorize(principal, tenantUsers(fixture.outsider.organizationId), claims),
  ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
});

test("root is refused once a platform writer exists unless break-glass is set", async () => {
  const root: Principal = { type: "root", grants: [] };
  const required: Required = { platform: "platform:write" };
  expect(await authorize(root, required)).toBe("platform");
  for (const environment of [
    { ...fixture.environment, rootAdminBreakGlass: false },
    { ...fixture.environment, rootAdminSecret: undefined },
  ])
    await expect(
      authorize(root, required, undefined, environment),
    ).rejects.toMatchObject({ status: 403, code: "root_locked" });
});

test("a machine token must carry the client's current instance and authorisation versions", async () => {
  const { principal, claims } = await machine(
    fixture.platform.client.clientId,
    ["platform:write"],
  );
  const required: Required = { platform: "platform:write" };
  expect(await authorize(principal, required, claims)).toBe("platform");
  for (const stale of [
    { authorizationVersion: claims.authorizationVersion + 1 },
    {
      organizationAuthorizationVersion:
        claims.organizationAuthorizationVersion + 1,
    },
    { clientInstance: createId() },
    { organizationId: fixture.tenant.organizationId },
    { expiresAt: Date.now() / 1000 - 1 },
  ])
    await expect(
      authorize(principal, required, { ...claims, ...stale }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  await expect(authorize(principal, required)).rejects.toMatchObject({
    code: "invalid_token",
  });
});

test("a machine whose approval is disabled after admission is refused", async () => {
  const { principal, claims } = await machine(
    fixture.platform.client.clientId,
    ["platform:write"],
  );
  const approval = eq(
    organizationCapabilities.clientId,
    fixture.platform.client.clientId,
  );
  await fixture.db
    .update(organizationCapabilities)
    .set({ status: "disabled" })
    .where(approval);
  try {
    await expect(
      authorize(principal, { platform: "platform:write" }, claims),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
  } finally {
    await fixture.db
      .update(organizationCapabilities)
      .set({ status: "active" })
      .where(approval);
  }
});
