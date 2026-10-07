// Real Answerable ID for the MCP acceptance (packages/acceptance), booted on its own database.
// It starts and trusts a company directory per tenant, optionally the platform organisation's and the spare ones, and queues their sign-ins.
// startId (packages/acceptance/src/id.ts) provisions everything else through the admin API, the tenants' organisations, domains and single sign-on first.
// Test-only: never imported by a production service.
import { rename } from "node:fs/promises";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  startOidcIssuer,
  type OidcClaims,
} from "../src/__tests__/oidc-issuer.ts";
import { createRuntimeLogin } from "../src/__tests__/runtime-role.ts";
import { testEnvironment } from "../src/__tests__/support.ts";

const [planPath, manifestPath] = process.argv.slice(2);
if (!planPath || !manifestPath || !process.argv.includes("--isolated-mcp-fixture"))
  throw new Error("Use the isolated MCP acceptance runner");

// Every company directory is a local test issuer whose one person signs in `signIns` times.
const queued = z.number().int().min(0);
const directory = z.object({ slug: z.string().min(1), signIns: queued });
const plan = z
  .object({
    // One company directory per tenant, for the organisation startId creates.
    tenants: z.array(directory),
    // A company directory for the platform organisation (Answerable staff), so
    // staff can sign in during a journey: `signIns` times its staff member, or,
    // in order, the person of each sign-in, such as ["staff", "colleague",
    // "staff"] for a second member between two of the first's.
    platform: z
      .object({
        signIns: z.union([queued, z.array(z.string().regex(/^[a-z]+$/))]),
      })
      .optional(),
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
// Serve through a restricted runtime role, as production does.
const runtime = (await createRuntimeLogin(setup.db, environment)).connection;
const auth = createAuth(runtime.db, environment);
// The acceptance runs this fixture under bun test, so NODE_ENV is test and Better Auth would skip its
// origin and CSRF checks; the journeys prove ID as deployed, with the checks on.
const authContext = await auth.$context;
authContext.skipOriginCheck = false;
authContext.skipCSRFCheck = false;
const app = createApp({ auth, db: runtime.db, environment });
Bun.serve({ hostname: "127.0.0.1", port: 47_600, fetch: app.fetch });

type Upstream = Awaited<ReturnType<typeof startOidcIssuer>>;

// A company directory for `slug` whose person, `<person>@<slug>.example.test`, signs in `signIns` times; or, given a list, whose sign-ins are each
// listed person's, in order. Each company sign-in consumes one queued identity. Returns what an organisation's domain and single sign-on need to use it.
function openDirectory(
  upstream: Upstream,
  slug: string,
  person: string,
  signIns: number | readonly string[],
) {
  const domain = `${slug}.example.test`;
  const email = `${person}@${domain}`;
  const people =
    typeof signIns === "number"
      ? Array.from({ length: signIns }, () => person)
      : signIns;
  for (const who of people) {
    const claims: OidcClaims = {
      sub: `${slug}-${who}`,
      email: `${who}@${domain}`,
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

// startId creates each tenant's organisation and connects the organisations to these directories; a spare has no organisation: the journey creates one.
const tenants = plan.tenants.map(({ slug, signIns }, index) =>
  openDirectory(tenantUpstreams[index]!, slug, "tester", signIns),
);
const platform =
  plan.platform && platformUpstream
    ? openDirectory(platformUpstream, platformSlug, "staff", plan.platform.signIns)
    : undefined;
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
    // The platform organisation is the one ID bound at boot, found through that binding and not by its slug.
    platformOrganizationId: seeded.organizationId,
    tenants,
    platform,
    spares,
  }),
);
await rename(`${manifestPath}.partial`, manifestPath);
console.log("Isolated ID fixture ready");
// The runner ends this process with SIGKILL, then removes the database.
