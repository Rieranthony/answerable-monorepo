import { and } from "drizzle-orm";
import {
  requirePlatformReadContext,
  requirePlatformWriteContext,
  type PlatformReadContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  requireTenantMemberAccessContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import { eq, sql } from "drizzle-orm";

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
  context: PlatformWriteContext,
  input: CreateSsoProviderInput,
) {
  const { tx: db } = requirePlatformWriteContext(context);
  const [reserved] = await db
    .select({
      deletedAt: ssoProviders.deletedAt,
      organizationId: ssoProviders.organizationId,
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.providerId, input.providerId));
  const [provider] = await db
    .insert(ssoProviders)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      providerId:
        reserved?.deletedAt && reserved.organizationId === input.organizationId
          ? `${input.providerId}-${createId()}`
          : input.providerId,
      issuer: input.issuer,
      domain: input.domain.trim().toLowerCase(),
      oidcConfig: serializeSsoProviderConfig(input),
    })
    .returning();

  return provider!;
}

function providerQuery(db: Executor, organizationId: string) {
  return db
    .select()
    .from(ssoProviders)
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .limit(1);
}

export async function findSsoProviderForCommand(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const [provider] = await providerQuery(tx, organizationId).for("update");
  await context.revalidate();
  return provider ?? null;
}

export async function readSsoProvider(context: TenantReadContext<"directory">) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  const [provider] = await providerQuery(tx, organizationId);
  return provider ? redactSsoProvider(provider) : null;
}

export async function readSsoIssuer(
  context: TenantReadContext<"memberAccess">,
) {
  const { tx, organizationId } = requireTenantMemberAccessContext(context);
  const [provider] = await tx
    .select({ issuer: ssoProviders.issuer })
    .from(ssoProviders)
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .limit(1);
  return provider ?? null;
}

export async function readSsoEndpoints(
  context: PlatformReadContext,
  organizationId: string,
) {
  const { tx } = requirePlatformReadContext(context);
  const [provider] = await tx
    .select({
      issuer: ssoProviders.issuer,
      discoveryEndpoint: sql<
        string | null
      >`${ssoProviders.oidcConfig}::jsonb ->> 'discoveryEndpoint'`,
    })
    .from(ssoProviders)
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .limit(1);
  return provider
    ? {
        issuer: provider.issuer,
        discoveryEndpoint: provider.discoveryEndpoint ?? undefined,
      }
    : null;
}

export async function updateSsoProvider(
  context: PlatformWriteContext,
  id: string,
  input: Pick<CreateSsoProviderInput, "issuer" | "domain" | "oidc">,
) {
  const { tx: db } = requirePlatformWriteContext(context);
  const [provider] = await db
    .update(ssoProviders)
    .set({
      issuer: input.issuer,
      domain: input.domain.trim().toLowerCase(),
      oidcConfig: serializeSsoProviderConfig(input),
    })
    .where(and(sql`${ssoProviders.deletedAt} is null`, eq(ssoProviders.id, id)))
    .returning();
  return provider!;
}

export async function deleteSsoProvider(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(ssoProviders)
    .set({ deletedAt: sql`now()`, oidcConfig: null, samlConfig: null })
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

export function redactSsoProvider(row: typeof ssoProviders.$inferSelect) {
  const config = JSON.parse(
    row.oidcConfig ?? "{}",
  ) as CreateSsoProviderInput["oidc"];
  return {
    id: row.id,
    revision: row.revision,
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
