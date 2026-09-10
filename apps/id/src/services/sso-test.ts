import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { type PlatformReadContext } from "./platform-context.ts";
import { readSsoEndpoints } from "../db/queries/sso-providers.ts";
import { ProblemError } from "../http/problem.ts";
import { classifyIssuer } from "./federation.ts";

export const ssoProblemCodes = [
  "insecure_issuer",
  "private_host",
  "discovery_unreachable",
  "discovery_invalid",
  "issuer_mismatch",
  "jwks_unreachable",
  "jwks_invalid",
] as const;
export type SsoTestOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowPrivateHosts?: boolean;
};
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv6");

function isPrivateHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "internal" ||
    host.endsWith(".internal") ||
    host === "local" ||
    host.endsWith(".local") ||
    (isIP(host) !== 0 &&
      privateNetworks.check(host, isIP(host) === 6 ? "ipv6" : "ipv4"))
  );
}
const discoverySchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
const jwksSchema = z.object({
  keys: z.array(z.object({ kty: z.string().min(1) })),
});
const maxBytes = 256 * 1024;

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Body exceeds 256 KiB");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Read only the endpoint snapshot needed by the connectivity probe. */
export async function getSsoTestConfiguration(
  context: PlatformReadContext,
  organizationId: string,
) {
  const provider = await readSsoEndpoints(context, organizationId);
  if (!provider)
    throw new ProblemError(404, "provider_not_found", "SSO provider not found");
  return provider;
}

/** No database access: run after the authorised snapshot transaction closes. */
export async function testSsoProvider(
  configuration: { issuer: string; discoveryEndpoint?: string },
  options: SsoTestOptions = {},
) {
  const started = performance.now();
  const { issuer } = configuration;
  const url =
    configuration.discoveryEndpoint ??
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const result = {
    issuer,
    kind: classifyIssuer(issuer).kind,
    discovery: {
      url,
      reachable: false,
      status: null as number | null,
      issuerMatches: null as boolean | null,
      authorizationEndpoint: null as string | null,
      tokenEndpoint: null as string | null,
      jwksUri: null as string | null,
    },
    jwks: { reachable: false, keys: null as number | null },
    elapsedMs: 0,
    problems: [] as {
      code: (typeof ssoProblemCodes)[number];
      detail: string;
    }[],
  };
  function problem(code: (typeof ssoProblemCodes)[number], detail: string) {
    result.problems.push({ code, detail });
  }
  function allowed(value: string) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      problem("insecure_issuer", "Endpoint must be an absolute HTTPS URL");
      return false;
    }
    const privateHost = isPrivateHost(parsed.hostname);
    if (
      parsed.protocol !== "https:" &&
      !(options.allowPrivateHosts && privateHost && parsed.protocol === "http:")
    ) {
      problem("insecure_issuer", "Issuer and fetched endpoints must use HTTPS");
      return false;
    }
    if (privateHost && !options.allowPrivateHosts) {
      problem("private_host", "Private hosts are not allowed");
      return false;
    }
    return true;
  }
  // Like the sign-in guard, reject hostnames resolving to internal addresses.
  async function publicDestination(value: string) {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    if (options.allowPrivateHosts || isIP(host)) return true;
    const addresses = await dns.lookup(host, { all: true });
    if (addresses.some(({ address }) => isPrivateHost(address))) {
      problem(
        "private_host",
        "Endpoint hostname resolves to a private address",
      );
      return false;
    }
    return true;
  }
  async function inspect() {
    if (!allowed(issuer) || !allowed(url)) return;
    const fetcher = options.fetch ?? fetch;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 5000);
    let response: Response;
    try {
      if (!(await publicDestination(url))) return;
      response = await fetcher(url, { signal, redirect: "manual" });
      result.discovery.status = response.status;
      if (!response.ok) throw new Error("HTTP failure or redirect");
    } catch {
      problem(
        "discovery_unreachable",
        "Discovery request failed, timed out or returned a non-success status",
      );
      return;
    }
    result.discovery.reachable = true;
    let discovery: z.infer<typeof discoverySchema>;
    try {
      discovery = discoverySchema.parse(await readJson(response));
    } catch {
      problem(
        "discovery_invalid",
        "Discovery must contain issuer, authorization_endpoint, token_endpoint and jwks_uri URLs within 256 KiB",
      );
      return;
    }
    result.discovery.issuerMatches = discovery.issuer === issuer;
    result.discovery.authorizationEndpoint = discovery.authorization_endpoint;
    result.discovery.tokenEndpoint = discovery.token_endpoint;
    result.discovery.jwksUri = discovery.jwks_uri;
    if (!result.discovery.issuerMatches)
      problem(
        "issuer_mismatch",
        "Discovery issuer does not exactly match the configured issuer",
      );
    if (!allowed(discovery.jwks_uri)) return;
    try {
      if (!(await publicDestination(discovery.jwks_uri))) return;
      response = await fetcher(discovery.jwks_uri, {
        signal,
        redirect: "manual",
      });
      if (!response.ok) throw new Error("HTTP failure or redirect");
    } catch {
      problem(
        "jwks_unreachable",
        "JWKS request failed, timed out or returned a non-success status",
      );
      return;
    }
    result.jwks.reachable = true;
    try {
      result.jwks.keys = jwksSchema.parse(await readJson(response)).keys.length;
    } catch {
      problem(
        "jwks_invalid",
        "JWKS must contain an array of keys with kty within 256 KiB",
      );
    }
  }
  await inspect();
  result.elapsedMs = Math.max(0, performance.now() - started);
  return result;
}
