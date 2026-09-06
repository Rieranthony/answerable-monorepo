import { eq } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { ssoProviders } from "../schema/index.ts";

type TokenEndpointAuthentication =
  "client_secret_post" | "client_secret_basic" | "private_key_jwt";

export type CreateSsoProviderInput = {
  organizationId: string;
  providerId: string;
  issuer: string;
  domain: string;
  oidc: {
    clientId: string;
    clientSecret?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    jwksEndpoint?: string;
    tokenEndpointAuthentication?: TokenEndpointAuthentication;
    scopes?: string[];
    pkce?: boolean;
    discoveryEndpoint?: string;
  };
};

export function serializeSsoProviderConfig(
  input: Pick<CreateSsoProviderInput, "issuer" | "oidc">,
): string {
  return JSON.stringify({
    issuer: input.issuer,
    clientId: input.oidc.clientId,
    clientSecret: input.oidc.clientSecret,
    authorizationEndpoint: input.oidc.authorizationEndpoint,
    tokenEndpoint: input.oidc.tokenEndpoint,
    tokenEndpointAuthentication:
      input.oidc.tokenEndpointAuthentication ?? "client_secret_post",
    privateKeyId: undefined,
    privateKeyAlgorithm: undefined,
    jwksEndpoint: input.oidc.jwksEndpoint,
    pkce: input.oidc.pkce ?? true,
    discoveryEndpoint:
      input.oidc.discoveryEndpoint ??
      `${input.issuer}/.well-known/openid-configuration`,
    mapping: undefined,
    scopes: input.oidc.scopes,
    userInfoEndpoint: undefined,
    overrideUserInfo: false,
  });
}

export async function createSsoProvider(
  db: Executor,
  input: CreateSsoProviderInput,
) {
  const [provider] = await db
    .insert(ssoProviders)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      issuer: input.issuer,
      domain: input.domain.trim().toLowerCase(),
      oidcConfig: serializeSsoProviderConfig(input),
    })
    .returning();

  return provider!;
}

export async function findSsoProviderByOrganization(
  db: Executor,
  organizationId: string,
) {
  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId))
    .limit(1);
  return provider ?? null;
}

export async function updateSsoProvider(
  db: Executor,
  id: string,
  input: Pick<CreateSsoProviderInput, "issuer" | "domain" | "oidc">,
) {
  const [provider] = await db
    .update(ssoProviders)
    .set({
      issuer: input.issuer,
      domain: input.domain.trim().toLowerCase(),
      oidcConfig: serializeSsoProviderConfig(input),
    })
    .where(eq(ssoProviders.id, id))
    .returning();
  return provider!;
}

export async function deleteSsoProvider(
  executor: Executor,
  organizationId: string,
) {
  const [row] = await executor
    .delete(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId))
    .returning();
  return row ?? null;
}

export function redactSsoProvider(row: typeof ssoProviders.$inferSelect) {
  const config = JSON.parse(
    row.oidcConfig ?? "{}",
  ) as CreateSsoProviderInput["oidc"];
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    issuer: row.issuer,
    domain: row.domain,
    oidc: {
      clientId: config.clientId,
      tokenEndpointAuthentication: config.tokenEndpointAuthentication,
      discoveryEndpoint: config.discoveryEndpoint,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      jwksEndpoint: config.jwksEndpoint,
      scopes: config.scopes,
      pkce: config.pkce,
      hasClientSecret: Boolean(config.clientSecret),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
