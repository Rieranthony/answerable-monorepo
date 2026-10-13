// Company directories on the host for the kind stack (infra/k8s/local), so that a person can sign in to the ID that runs
// in the cluster: `bun apps/id/scripts/stack-directories.ts <plan.json> <manifest.json>`. Each is the test issuer of
// src/__tests__/oidc-issuer.ts on its own port, listening where the cluster's pods reach it, and whose one person signs
// in `signIns` times. A browser on the host is sent to its authorisation endpoint at `browserOrigin`; ID's pods fetch its
// token endpoint and keys at `podOrigin`. The manifest holds what an organisation's domain and single sign-on need, as
// the acceptance fixture's (scripts/mcp-e2e-fixture.ts). Runs until it is stopped. Test-only: never part of an image.
import { rename } from "node:fs/promises";
import { z } from "zod";
import {
  startOidcIssuer,
  type OidcClaims,
} from "../src/__tests__/oidc-issuer.ts";

const [planPath, manifestPath] = process.argv.slice(2);
if (!planPath || !manifestPath)
  throw new Error(
    "Usage: bun apps/id/scripts/stack-directories.ts <plan.json> <manifest.json>",
  );

const plan = z
  .object({
    // Where the directories listen: the first on `port`, the next on `port + 1`, and so on.
    hostname: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    // http://<host> without a port, as the browser and the pods reach the host.
    browserHost: z.url(),
    podHost: z.url(),
    directories: z.array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        person: z.string().regex(/^[a-z]+$/),
        signIns: z.number().int().min(1),
      }),
    ),
  })
  .parse(await Bun.file(planPath).json());

const directories = [];
for (const [index, { slug, person, signIns }] of plan.directories.entries()) {
  const port = plan.port + index;
  const browserOrigin = `${plan.browserHost}:${port}`;
  const podOrigin = `${plan.podHost}:${port}`;
  // The issuer is the browser's origin: ID compares it with the ID token's `iss`, which this issuer writes.
  const upstream = await startOidcIssuer({
    hostname: plan.hostname,
    port,
    origin: browserOrigin,
  });
  const domain = `${slug}.example.test`;
  const email = `${person}@${domain}`;
  for (let signIn = 0; signIn < signIns; signIn++) {
    const claims: OidcClaims = {
      sub: `${slug}-${person}`,
      email,
      email_verified: true,
      name: "Stack tester",
    };
    // The time of the sign-in, not of boot, as the acceptance fixture does.
    Object.defineProperty(claims, "auth_time", {
      enumerable: true,
      get: () => Math.floor(Date.now() / 1000),
    });
    upstream.enqueue(claims);
  }
  directories.push({
    slug,
    domain,
    email,
    issuer: browserOrigin,
    authorizationEndpoint: `${browserOrigin}/authorize`,
    tokenEndpoint: `${podOrigin}/token`,
    jwksEndpoint: `${podOrigin}/jwks`,
    clientId: slug,
    clientSecret: "local-stack-only",
  });
}

// The stack polls for this file, so it appears whole or not at all.
await Bun.write(`${manifestPath}.partial`, JSON.stringify({ directories }));
await rename(`${manifestPath}.partial`, manifestPath);
console.log(
  `Stack directories ready on ${plan.hostname}:${plan.port}${plan.directories.length > 1 ? `-${plan.port + plan.directories.length - 1}` : ""}`,
);
