import {
  computeDiscoveryUrl,
  discoverOIDCConfig,
  DiscoveryError,
} from "@better-auth/sso";
import { z } from "zod";
import { type PlatformReadContext } from "./platform-context.ts";
import { readSsoEndpoints } from "../db/queries/sso-providers.ts";
import { ProblemError } from "../http/problem.ts";
import { classifyIssuer } from "./federation.ts";

export const ssoProblemCodes = [
  "untrusted_origin",
  "insecure_issuer",
  "discovery_unreachable",
  "discovery_invalid",
  "issuer_mismatch",
  "jwks_unreachable",
  "jwks_invalid",
] as const;
type SsoProblemCode = (typeof ssoProblemCodes)[number];
export type SsoTestOptions = {
  /** ID's trusted origins, which sign-in's discovery requires of every endpoint. */
  trustedOrigins: string[];
  /** Per request; sign-in's default, 10 s, when absent. */
  timeoutMs?: number;
};

/** Sign-in's discovery errors in the probe's words; the rest mean unreachable. */
const discoveryProblems: Partial<Record<string, SsoProblemCode>> = {
  discovery_untrusted_origin: "untrusted_origin",
  discovery_invalid_url: "insecure_issuer",
  discovery_invalid_json: "discovery_invalid",
  discovery_incomplete: "discovery_invalid",
  issuer_mismatch: "issuer_mismatch",
};
const jwksSchema = z.object({
  keys: z.array(z.object({ kty: z.string().min(1) })),
});

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

/**
 * Discovery as sign-in runs it, the pinned SSO plugin's `discoverOIDCConfig`,
 * then the JWKS fetch sign-in makes when it verifies an ID token. No database
 * access: run after the authorised snapshot transaction closes.
 */
export async function testSsoProvider(
  configuration: { issuer: string; discoveryEndpoint?: string },
  options: SsoTestOptions,
) {
  const started = performance.now();
  const { issuer } = configuration;
  const url = configuration.discoveryEndpoint ?? computeDiscoveryUrl(issuer);
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
    problems: [] as { code: SsoProblemCode; detail: string }[],
  };
  const isTrustedOrigin = (value: string) =>
    URL.canParse(value) &&
    options.trustedOrigins.includes(new URL(value).origin);
  async function inspect() {
    let jwksUri: string;
    try {
      const discovered = await discoverOIDCConfig({
        issuer,
        discoveryEndpoint: url,
        isTrustedOrigin,
        timeout: options.timeoutMs,
      });
      // The plugin accepts only a successful (2xx) answer.
      result.discovery = {
        url,
        reachable: true,
        status: 200,
        issuerMatches: true,
        authorizationEndpoint: discovered.authorizationEndpoint,
        tokenEndpoint: discovered.tokenEndpoint,
        jwksUri: discovered.jwksEndpoint,
      };
      jwksUri = discovered.jwksEndpoint;
    } catch (error) {
      // Past the fetch, the plugin throws a TypeError on an endpoint that is
      // not a string; everything else is a DiscoveryError.
      const known = error instanceof DiscoveryError;
      const code = known
        ? (discoveryProblems[error.code] ?? "discovery_unreachable")
        : "discovery_invalid";
      const status = known
        ? (error.details as { status?: unknown } | undefined)?.status
        : undefined;
      if (typeof status === "number") result.discovery.status = status;
      if (code === "discovery_invalid" || code === "issuer_mismatch")
        result.discovery.reachable = true;
      if (code === "issuer_mismatch") result.discovery.issuerMatches = false;
      result.problems.push({
        code,
        detail: known
          ? error.message
          : "Discovery endpoints must be URL strings",
      });
      return;
    }
    let response: Response;
    try {
      response = await fetch(jwksUri, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) throw new Error("HTTP failure or redirect");
    } catch {
      result.problems.push({
        code: "jwks_unreachable",
        detail:
          "JWKS request failed, timed out or returned a non-success status",
      });
      return;
    }
    result.jwks.reachable = true;
    try {
      result.jwks.keys = jwksSchema.parse(await response.json()).keys.length;
    } catch {
      result.problems.push({
        code: "jwks_invalid",
        detail: "JWKS must contain an array of keys with kty",
      });
    }
  }
  await inspect();
  result.elapsedMs = Math.max(0, performance.now() - started);
  return result;
}
