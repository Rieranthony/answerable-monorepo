// Real Answerable ID for the MCP acceptance (packages/acceptance), booted on its own database.
// It provisions each tenant's organisation, domain and company directory, optionally the platform organisation's and the spare directories, and leaves everything else to the admin API.
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
import {
  startOidcIssuer,
  type OidcClaims,
} from "../src/__tests__/oidc-issuer.ts";
import { testEnvironment } from "../src/__tests__/support.ts";

const [planPath, manifestPath] = process.argv.slice(2);
if (!planPath || !manifestPath || !process.argv.includes("--isolated-mcp-fixture"))
  throw new Error("Use the isolated MCP acceptance runner");

// Every company directory is a local test issuer whose one person signs in `signIns` times.
const queued = z.number().int().min(0);
const directory = z.object({ slug: z.string().min(1), signIns: queued });
const plan = z
  .object({
    // One organisation per tenant, with its domain and its own company directory.
    tenants: z.array(directory),
    // Gives the platform organisation (Answerable staff) a domain and a company
    // directory, so a staff member can sign in during a journey.
    platform: z.object({ signIns: queued }).optional(),
    // Company directories that ID trusts from boot but that belong to no
    // organisation yet, for the organisations a journey creates later: ID
    // accepts an identity provider's endpoints only if they were listed at boot.
    spares: z.array(directory).default([]),
  })
  .parse(await Bun.file(planPath).json());

// A separate container and port, never DATABASE_URL or the normal test database.
const databaseUrl =
  "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test";
const idOrigin = "http://127.0.0.1:47600";
const callback = "http://127.0.0.1:47603/callback";
const rootSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const platformSlug = "answerable";
const tenantUpstreams = await Promise.all(
  plan.tenants.map(() => startOidcIssuer()),
);
const platformUpstream = plan.platform ? await startOidcIssuer() : undefined;
const spareUpstreams = await Promise.all(
  plan.spares.map(() => startOidcIssuer()),
);
const upstreams = [
  ...tenantUpstreams,
  ...(platformUpstream ? [platformUpstream] : []),
  ...spareUpstreams,
];
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
const seeded = await bootstrap(setup.db, systemActor("mcp-e2e"), {
  platformOrganizationSlug: platformSlug,
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

type Upstream = Awaited<ReturnType<typeof startOidcIssuer>>;

// A company directory for `slug`: its one person, `<person>@<slug>.example.test`, signs in `signIns` times, and each company sign-in consumes one queued identity.
// Returns what an organisation's single sign-on needs to use it.
function openDirectory(
  upstream: Upstream,
  slug: string,
  person: string,
  signIns: number,
) {
  const domain = `${slug}.example.test`;
  const email = `${person}@${domain}`;
  for (let signIn = 0; signIn < signIns; signIn++) {
    const claims: OidcClaims = {
      sub: `${slug}-${person}`,
      email,
      email_verified: true,
      name: "MCP tester",
    };
    // The issuer copies these claims into the ID token when it answers the
    // token request, so a getter makes `auth_time` the time of that sign-in,
    // not of boot: the sign-in time ID reads for a Verify sign-in, and a
    // person who signs in minutes after boot still carries a recent one.
    Object.defineProperty(claims, "auth_time", {
      enumerable: true,
      get: () => Math.floor(Date.now() / 1000),
    });
    upstream.enqueue(claims);
  }
  return {
    slug,
    domain,
    email,
    issuer: upstream.origin,
    authorizationEndpoint: `${upstream.origin}/authorize`,
    tokenEndpoint: `${upstream.origin}/token`,
    jwksEndpoint: `${upstream.origin}/jwks`,
    clientId: slug,
    clientSecret: "local-fixture-only",
  };
}

// Route the organisation's domain to the directory and set its single sign-on there, as an operator does through the admin API.
async function connectDirectory(
  organizationId: string,
  {
    domain,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksEndpoint,
    clientId,
    clientSecret,
  }: ReturnType<typeof openDirectory>,
) {
  const path = `/organizations/${organizationId}`;
  await admin("POST", `${path}/domains`, { domain });
  await admin(
    "PUT",
    `${path}/sso-provider`,
    {
      issuer,
      domain,
      oidc: {
        credentials: "own",
        clientId,
        clientSecret,
        authorizationEndpoint,
        tokenEndpoint,
        jwksEndpoint,
      },
    },
    { "If-None-Match": "*" },
  );
}

const tenants = [];
for (const [index, { slug, signIns }] of plan.tenants.entries()) {
  const company = openDirectory(
    tenantUpstreams[index]!,
    slug,
    "tester",
    signIns,
  );
  const organization = await admin("POST", "/organizations", {
    slug,
    name: slug,
  });
  const organizationId = String(organization.id);
  await connectDirectory(organizationId, company);
  tenants.push({ slug, email: company.email, organizationId });
}

// The platform organisation is the one ID bound at boot, found through that binding and not by its slug.
let platform;
if (plan.platform && platformUpstream) {
  const staff = openDirectory(
    platformUpstream,
    platformSlug,
    "staff",
    plan.platform.signIns,
  );
  const organizationId = seeded.organization.id;
  await connectDirectory(organizationId, staff);
  platform = { organizationId, domain: staff.domain, email: staff.email };
}

// A spare has no organisation: the journey creates one and sets its single sign-on from this entry.
const spares = plan.spares.map(({ slug, signIns }, index) =>
  openDirectory(spareUpstreams[index]!, slug, "tester", signIns),
);

// The runner polls for this file, so it appears whole or not at all.
await Bun.write(
  `${manifestPath}.partial`,
  JSON.stringify({
    idOrigin,
    adminResource: environment.adminResourceIdentifier,
    rootSecret,
    tenants,
    platform,
    spares,
  }),
);
await rename(`${manifestPath}.partial`, manifestPath);
console.log("Isolated ID fixture ready");
// The runner ends this process with SIGKILL, then removes the database.
