// Real Answerable ID for the MCP acceptance (packages/acceptance), booted on its own database.
// It provisions each tenant's organisation, domain and company directory and leaves everything else to the admin API.
// Test-only: never imported by a production service.
import { rename } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { configureRuntimeRole } from "../src/db/runtime-role.ts";
import { startOidcIssuer } from "../src/__tests__/oidc-issuer.ts";
import { testEnvironment } from "../src/__tests__/support.ts";

const [planPath, manifestPath] = process.argv.slice(2);
if (!planPath || !manifestPath || !process.argv.includes("--isolated-mcp-fixture"))
  throw new Error("Use the isolated MCP acceptance runner");

// { tenants: [{ slug, signIns }] }: one organisation and one company directory per tenant.
const plan = z
  .object({
    tenants: z.array(
      z.object({ slug: z.string().min(1), signIns: z.number().int().min(0) }),
    ),
  })
  .parse(await Bun.file(planPath).json());

// A separate container and port, never DATABASE_URL or the normal test database.
const databaseUrl =
  "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test";
const idOrigin = "http://127.0.0.1:47600";
const callback = "http://127.0.0.1:47603/callback";
const rootSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const upstreams = await Promise.all(plan.tenants.map(() => startOidcIssuer()));
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
Bun.serve({ hostname: "127.0.0.1", port: 47_600, fetch: app.fetch });

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

const tenants = [];
for (const [index, { slug, signIns }] of plan.tenants.entries()) {
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
  const email = `tester@${domain}`;
  // Each company sign-in consumes one queued identity.
  for (let signIn = 0; signIn < signIns; signIn++)
    upstream.enqueue({
      sub: `${slug}-tester`,
      email,
      email_verified: true,
      name: "MCP tester",
      auth_time: Math.floor(Date.now() / 1000),
    });
  tenants.push({ slug, email, organizationId });
}

// The runner polls for this file, so it appears whole or not at all.
await Bun.write(
  `${manifestPath}.partial`,
  JSON.stringify({
    idOrigin,
    adminResource: environment.adminResourceIdentifier,
    rootSecret,
    tenants,
  }),
);
await rename(`${manifestPath}.partial`, manifestPath);
console.log("Isolated ID fixture ready");
// The runner ends this process with SIGKILL, then removes the database.
