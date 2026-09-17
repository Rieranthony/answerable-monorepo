// Isolated fixture preparation. Never imported by a production service.
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import { testEnvironment } from "../src/__tests__/support.ts";
import { startOidcIssuer } from "../src/__tests__/oidc-issuer.ts";
import { inPlatformWrite } from "../src/__tests__/platform-context.ts";
import { createSsoProvider } from "../src/db/queries/sso-providers.ts";
import { createOrganizationDomain } from "../src/db/queries/organization-domains.ts";
import { createCapability } from "../src/services/capabilities.ts";
import { createId } from "../src/lib/id.ts";
import { organizations, oauthClients, oauthResources, oauthClientResources, entitlements } from "../src/db/schema/index.ts";
import { configureRuntimeRole } from "../src/db/runtime-role.ts";
import { sql } from "drizzle-orm";

const manifestPath = process.argv[2];
if (!manifestPath || !process.argv.includes("--isolated-mcp-fixture")) throw new Error("Use the isolated MCP e2e runner");
// Fixed separate container/port, not DATABASE_URL or the normal ID test database.
const databaseUrl = "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test";
const idOrigin = "http://127.0.0.1:47600";
const mcpOrigin = "http://127.0.0.1:47602";
const callback = "http://127.0.0.1:47603/callback";
const upstreams = await Promise.all([startOidcIssuer(), startOidcIssuer()]);
const environment = testEnvironment({
  databaseUrl, betterAuthUrl: idOrigin, port: 47600,
  adminResourceIdentifier: `${idOrigin}/api/admin`,
  trustedOrigins: [callback, ...upstreams.map(upstream => upstream.origin)], databasePoolMax: 4,
});
const setup = createDatabase(environment);
await runMigrations(setup.db);
await bootstrap(setup.db, systemActor("mcp-e2e"), {
  platformOrganizationSlug: "answerable", platformOrganizationName: "Answerable",
  adminResourceIdentifier: environment.adminResourceIdentifier,
});
const clientId = "mcp-e2e-browser";
const resource = `${mcpOrigin}/mcp`;
const resourceInstanceId = createId();
const scopes = ["e2e:identity", "e2e:read", "e2e:write"];
await setup.db.insert(oauthClients).values({
  id: createId(), clientId, name: "MCP local acceptance", scopes: ["openid", "offline_access", ...scopes],
  grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"],
  redirectUris: [callback], tokenEndpointAuthMethod: "none", requirePKCE: true, skipConsent: false,
});
await setup.db.insert(oauthResources).values({ id: resourceInstanceId, identifier: resource, name: "MCP e2e", allowedScopes: [...scopes, "offline_access"], accessTokenTtl: 60 });
await setup.db.insert(oauthClientResources).values({ id: createId(), clientId, resourceId: resource });
const tenants = [];
for (const [index, slug] of ["mcp-alpha", "mcp-beta"].entries()) {
  const upstream = upstreams[index]!;
  const organizationId = createId();
  const domain = `${slug}.example.test`;
  await setup.db.insert(organizations).values({ id: organizationId, slug, name: slug });
  await inPlatformWrite(setup.db, async context => {
    await createOrganizationDomain(context, { organizationId, domain });
    await createSsoProvider(context, { organizationId, providerId: slug, domain, issuer: upstream.origin, oidc: {
      clientId: slug, clientSecret: "local-fixture-only", authorizationEndpoint: `${upstream.origin}/authorize`,
      tokenEndpoint: `${upstream.origin}/token`, jwksEndpoint: `${upstream.origin}/jwks`,
    } });
    for (const grantKind of ["authorization_code", "refresh_token"] as const) {
      await createCapability(context, organizationId, { clientId, resource: null, grantKind, scopes: ["openid", "offline_access"] });
      await createCapability(context, organizationId, { clientId, resource, grantKind, scopes });
    }
  });
  await setup.db.insert(entitlements).values([
    { id: createId(), organizationId, clientId, scopes: ["openid", "offline_access"] },
    { id: createId(), organizationId, clientId, resource, scopes },
  ]);
  const email = `tester@${domain}`;
  upstream.enqueue({ sub: `${slug}-tester`, email, email_verified: true, name: "MCP tester", auth_time: Math.floor(Date.now() / 1000) });
  tenants.push({ organizationId, email, slug });
}
const role = "mcp_e2e_runtime";
await configureRuntimeRole(setup.db, role);
const password = crypto.randomUUID();
await setup.db.execute(sql.raw(`ALTER ROLE "${role}" LOGIN PASSWORD '${password}'`));
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = password;
const runtime = createDatabase({ ...environment, databaseUrl: runtimeUrl.href });
const auth = createAuth(runtime.db, environment);
const app = createApp({ auth, db: runtime.db, environment });
const server = Bun.serve({ hostname: "127.0.0.1", port: 47600, fetch: app.fetch });
await Bun.write(manifestPath, JSON.stringify({ idOrigin, mcpOrigin, callback, clientId, resource, resourceInstanceId, scopes, tenants }));
console.log("Isolated ID fixture ready");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.stop(true);
  for (const upstream of upstreams) upstream.stop();
  await runtime.close();
  await setup.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
