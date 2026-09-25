// Real Answerable ID for MCP acceptance, provisioned only through the admin API.
// Test-only: never imported by a production service.
import { sql } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { configureRuntimeRole } from "../src/db/runtime-role.ts";
import { startOidcIssuer } from "../src/__tests__/oidc-issuer.ts";
import { testEnvironment } from "../src/__tests__/support.ts";

const manifestPath = process.argv[2];
if (!manifestPath || !process.argv.includes("--isolated-mcp-fixture"))
  throw new Error("Use the isolated MCP acceptance runner");

// A separate container and port, never DATABASE_URL or the normal test database.
const databaseUrl =
  "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test";
const idOrigin = "http://127.0.0.1:47600";
const resource = "http://127.0.0.1:47602/mcp";
const callback = "http://127.0.0.1:47603/callback";
const clientId = "mcp-e2e-browser";
const scopes = ["e2e:identity", "e2e:read", "e2e:write"];
const rootSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const upstreams = await Promise.all([startOidcIssuer(), startOidcIssuer()]);
const environment = testEnvironment({
  databaseUrl,
  betterAuthUrl: idOrigin,
  port: 47_600,
  adminResourceIdentifier: `${idOrigin}/api/admin`,
  trustedOrigins: [callback, ...upstreams.map((upstream) => upstream.origin)],
  databasePoolMax: 4,
  rootAdminSecret: rootSecret,
});

const setup = createDatabase(environment);
await runMigrations(setup.db);
await bootstrap(setup.db, systemActor("mcp-e2e"), {
  platformOrganizationSlug: "answerable",
  platformOrganizationName: "Answerable",
  adminResourceIdentifier: environment.adminResourceIdentifier,
});
// Serve through the restricted runtime role, as production does.
const role = "mcp_e2e_runtime";
await configureRuntimeRole(setup.db, role);
const password = crypto.randomUUID();
await setup.db.execute(
  sql.raw(`ALTER ROLE "${role}" LOGIN PASSWORD '${password}'`),
);
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = password;
const runtime = createDatabase({
  ...environment,
  databaseUrl: runtimeUrl.href,
});
const auth = createAuth(runtime.db, environment);
const app = createApp({ auth, db: runtime.db, environment });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 47_600,
  fetch: app.fetch,
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${idOrigin}/api/admin/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${rootSecret}`,
      "Idempotency-Key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path} returned ${response.status}: ${await response.text()}`,
    );
  return (await response.json()) as Record<string, unknown>;
}

// The same registration an operator performs for a new MCP server.
await admin("POST", "/resources", {
  classification: "platform_shared",
  organizationId: null,
  identifier: resource,
  name: "E2E MCP",
  allowedScopes: [...scopes, "offline_access"],
  accessTokenTtl: 60,
});
await admin("POST", "/clients", {
  clientId,
  name: "MCP acceptance",
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code", "refresh_token"],
  redirectUris: [callback],
  scopes: ["openid", "offline_access", ...scopes],
});
await admin(
  "PUT",
  `/clients/${clientId}/resources/${encodeURIComponent(resource)}`,
);

const tenants = [];
for (const [index, slug] of ["mcp-alpha", "mcp-beta"].entries()) {
  const upstream = upstreams[index]!;
  const domain = `${slug}.example.test`;
  const organization = await admin("POST", "/organizations", {
    slug,
    name: slug,
  });
  const organizationId = String(organization.id);
  const path = `/organizations/${organizationId}`;
  await admin("POST", `${path}/domains`, { domain });
  await admin(
    "PUT",
    `${path}/sso-provider`,
    {
      issuer: upstream.origin,
      domain,
      oidc: {
        credentials: "own",
        clientId: slug,
        clientSecret: "local-fixture-only",
        authorizationEndpoint: `${upstream.origin}/authorize`,
        tokenEndpoint: `${upstream.origin}/token`,
        jwksEndpoint: `${upstream.origin}/jwks`,
      },
    },
    { "If-None-Match": "*" },
  );
  for (const grantKind of ["authorization_code", "refresh_token"]) {
    await admin("POST", `${path}/capabilities`, {
      clientId,
      resource: null,
      grantKind,
      scopes: ["openid", "offline_access"],
    });
    await admin("POST", `${path}/capabilities`, {
      clientId,
      resource,
      grantKind,
      scopes,
    });
  }
  await admin("POST", `${path}/entitlements`, {
    clientId,
    scopes: ["openid", "offline_access"],
  });
  await admin("POST", `${path}/entitlements`, { clientId, resource, scopes });
  const email = `tester@${domain}`;
  // Each company sign-in consumes one queued identity.
  for (let signIn = 0; signIn < 3; signIn++)
    upstream.enqueue({
      sub: `${slug}-tester`,
      email,
      email_verified: true,
      name: "MCP tester",
      auth_time: Math.floor(Date.now() / 1000),
    });
  tenants.push({ slug, email, organizationId });
}

await Bun.write(
  manifestPath,
  JSON.stringify({
    idOrigin,
    resource,
    callback,
    clientId,
    scopes,
    rootSecret,
    tenants,
  }),
);
console.log("Isolated ID fixture ready");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.stop(true);
  for (const upstream of upstreams) upstream.stop();
  await runtime.close();
  await setup.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
