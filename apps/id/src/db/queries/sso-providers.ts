import { createId } from "../../lib/id.ts";
import type { Database } from "../client.ts";
import { ssoProviders } from "../schema/index.ts";

type TokenEndpointAuthentication =
  | "client_secret_post"
  | "client_secret_basic"
  | "private_key_jwt";

type CreateSsoProviderInput = {
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

export async function createSsoProvider(
  db: Database,
  input: CreateSsoProviderInput,
) {
  const oidcConfig = JSON.stringify({
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
  const [provider] = await db
    .insert(ssoProviders)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      issuer: input.issuer,
      domain: input.domain.trim().toLowerCase(),
      oidcConfig,
    })
    .returning();

  return provider!;
}
