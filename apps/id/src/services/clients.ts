import { revokeClientGrantContexts } from "../db/queries/grant-contexts.ts";
import { requireNoCapabilityReferences } from "./capabilities.ts";
import {
  type PlatformWriteContext,
  type PlatformReadContext,
} from "./platform-context.ts";
import { z } from "zod";
import * as queries from "../db/queries/oauth-clients.ts";
import {
  lockResourceForCommand,
  readResourceForPolicy,
} from "../db/queries/oauth-resources.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { revokeClientTokens } from "../db/queries/oauth-tokens.ts";
import { recordCommandEvent } from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";
import { generateClientSecret, hashClientSecret } from "./client-secrets.ts";

type ClientRow = NonNullable<
  Awaited<ReturnType<typeof queries.lockClientForCommand>>
>;
export type CreateClientInput = {
  clientId?: string;
  name: string;
  organizationId?: string;
  tokenEndpointAuthMethod: "client_secret_basic" | "private_key_jwt" | "none";
  grantTypes: ("client_credentials" | "authorization_code" | "refresh_token")[];
  redirectUris: string[];
  clientCredentialsScopes?: string[];
  scopes?: string[];
  jwks?: string;
  jwksUri?: string;
  skipConsent?: boolean;
  uri?: string;
  contacts?: string[];
};
const notFound = "Client, resource or organisation not found";
function publicClient({ clientSecret, deletedAt, ...row }: ClientRow) {
  return {
    ...row,
    hasClientSecret: deletedAt === null && clientSecret !== null,
  };
}
/** Allowlisted security settings; credentials and raw JWK/provider configuration stay out. */
function auditClient(row: ClientRow) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    clientId: row.clientId,
    organizationId: row.organizationId,
    name: row.name,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    grantTypes: row.grantTypes,
    redirectUris: row.redirectUris,
    scopes: row.scopes,
    clientCredentialsScopes: row.clientCredentialsScopes,
    requirePKCE: row.requirePKCE,
    skipConsent: row.skipConsent,
    disabled: row.disabled,
    revision: row.revision,
    authorizationVersion: row.authorizationVersion,
    hasClientSecret: row.clientSecret !== null,
    hasJwks: row.jwks !== null,
    hasJwksUri: row.jwksUri !== null,
  };
}
/** Owning a client does not grant visibility into another tenant's private target. */
function auditResourceLink(
  context: PlatformWriteContext,
  client: ClientRow,
  identifier: string,
  resource: Awaited<ReturnType<typeof readResourceForPolicy>>,
  before: boolean,
  after: boolean,
  relationship: { id: string; deletedAt: Date | null } | null,
) {
  const visible =
    resource?.classification === "platform_shared" ||
    resource?.organizationId === client.organizationId;
  const organizationId = visible ? client.organizationId : null;
  return recordCommandEvent(context, {
    organizationId,
    targetType: "client",
    targetId: client.clientId,
    action:
      before === after
        ? "client.resource_unchanged"
        : after
          ? "client.resource_linked"
          : "client.resource_unlinked",
    data: {
      resource: identifier,
      relationship,
      resourceInstanceId: resource?.id ?? null,
      resourceClassification: resource?.classification ?? null,
      resourceOrganizationId: resource?.organizationId ?? null,
      before: { linked: before },
      after: { linked: after },
    },
  });
}
/** A client's owner is not entitled to its other tenants' grant identities. */
async function auditGrantEffects(
  context: PlatformWriteContext,
  client: ClientRow,
  grantContexts: { id: string; organizationId: string; userId: string }[],
  details:
    | {
        action: "client.grants_revoked";
        revokedTokens: Awaited<
          ReturnType<typeof revokeClientTokens>
        >["revokedTokens"];
      }
    | {
        action: "client.grants_erased";
        effects: Awaited<ReturnType<typeof queries.deleteClient>>["effects"];
      },
) {
  const { action, ...payload } = details;
  const hasEffects =
    "revokedTokens" in details
      ? details.revokedTokens.access.length > 0 ||
        details.revokedTokens.refresh.length > 0
      : Object.values(details.effects).some((rows) => rows.length > 0);
  if (!grantContexts.length && !hasEffects) return undefined;
  const event = await recordCommandEvent(context, {
    organizationId: null,
    targetType: "client",
    targetId: client.clientId,
    action,
    data: {
      clientInstanceId: client.id,
      grantContexts,
      ...payload,
      ...(action === "client.grants_erased" ? { deletionMode: "soft" } : {}),
    },
  });
  return event.id;
}
const jwkSetSchema = z.object({
  keys: z.array(z.object({ kty: z.string().min(1) }).loose()).min(1),
});
function validateClient(
  input: Pick<
    queries.ClientInput,
    | "tokenEndpointAuthMethod"
    | "grantTypes"
    | "redirectUris"
    | "clientCredentialsScopes"
    | "organizationId"
    | "jwks"
    | "jwksUri"
  >,
) {
  const errors: { path: string; message: string }[] = [];
  const machine = input.grantTypes?.includes("client_credentials");
  if (input.tokenEndpointAuthMethod === "none" && machine)
    errors.push({
      path: "tokenEndpointAuthMethod",
      message: "Public clients cannot use client_credentials",
    });
  if (machine && !input.clientCredentialsScopes?.length)
    errors.push({
      path: "clientCredentialsScopes",
      message: "Machine clients require at least one scope",
    });
  if (machine && !input.organizationId)
    errors.push({
      path: "organizationId",
      message: "Machine clients require an owning organisation",
    });
  if (
    input.grantTypes?.includes("authorization_code") &&
    !input.redirectUris.length
  )
    errors.push({
      path: "redirectUris",
      message: "Authorization code clients require at least one redirect URI",
    });
  if (input.tokenEndpointAuthMethod === "private_key_jwt") {
    const hasJwks = input.jwks !== undefined && input.jwks !== null;
    const hasJwksUri = input.jwksUri !== undefined && input.jwksUri !== null;
    if (hasJwks === hasJwksUri)
      errors.push({
        path: "jwks",
        message: "Provide exactly one of jwks or jwksUri",
      });
    if (hasJwks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.jwks!);
      } catch {
        parsed = null;
      }
      if (!jwkSetSchema.safeParse(parsed).success)
        errors.push({
          path: "jwks",
          message: "Provide a JWK set JSON string with at least one key",
        });
    }
  }
  if (errors.length)
    throw new ProblemError(
      400,
      "validation_failed",
      "The request is invalid",
      undefined,
      { errors },
    );
}
export async function listClients(
  context: PlatformReadContext,
  query: queries.ClientQuery,
) {
  return queries.listClients(context, query);
}
export async function getClient(
  context: PlatformReadContext,
  clientId: string,
) {
  // Keep the registration and its linked resources on the same revision.
  const row = found(await queries.readClient(context, clientId), notFound);
  return {
    ...row,
    resources: (await queries.listClientResources(context, clientId))
      .map((link) => link.resourceId)
      .sort(),
  };
}
export async function createClient(
  context: PlatformWriteContext,
  input: CreateClientInput,
) {
  validateClient(input);
  if (input.organizationId)
    found(
      await lockOrganizationForCommand(context, input.organizationId),
      notFound,
    );
  const clientId =
    input.clientId ??
    `client_${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
  const clientSecret =
    input.tokenEndpointAuthMethod === "client_secret_basic"
      ? generateClientSecret()
      : undefined;
  const row = await queries.createClient(context, {
    ...input,
    clientId,
    clientSecret:
      clientSecret === undefined ? null : hashClientSecret(clientSecret),
    responseTypes: input.grantTypes.includes("authorization_code")
      ? ["code"]
      : [],
    requirePKCE: true,
  });
  await recordCommandEvent(context, {
    organizationId: row.organizationId,
    targetType: "client",
    targetId: clientId,
    action: "client.created",
    data: { before: null, after: auditClient(row) },
  });
  return {
    ...publicClient(row),
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}
export async function updateClient(
  context: PlatformWriteContext,
  clientId: string,
  patch: queries.ClientPatch,
  expected?: { id: string; revision: number },
) {
  const existing = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  assertRevision(
    existing,
    expected,
    "Client changed; read its current revision before issuing a new command",
  );
  validateClient({ ...existing, ...patch });
  const changed = Object.entries(patch).some(
    ([key, value]) =>
      value !== undefined &&
      JSON.stringify(value) !==
        JSON.stringify(existing[key as keyof ClientRow]),
  );
  const row = changed
    ? await queries.updateClient(context, clientId, patch)
    : existing;
  await recordCommandEvent(context, {
    organizationId: row!.organizationId,
    targetType: "client",
    targetId: clientId,
    action: changed ? "client.updated" : "client.update_unchanged",
    data: {
      requestedFields: Object.keys(patch).sort(),
      before: auditClient(existing),
      after: auditClient(row!),
    },
  });
  return { body: publicClient(row!), changed };
}
async function setDisabled(
  context: PlatformWriteContext,
  clientId: string,
  disabled: boolean,
) {
  const existing = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  const stateChanged = existing.disabled !== disabled;
  const row = stateChanged
    ? (await queries.setClientDisabled(context, clientId, disabled))!
    : existing;
  const { revokedTokens, ...effects } = disabled
    ? await revokeClientTokens(context, clientId)
    : {
        refreshTokens: 0,
        accessTokens: 0,
        revokedTokens: { refresh: [], access: [] },
      };
  const revokedGrantContexts = disabled
    ? await revokeClientGrantContexts(context, existing.id)
    : [];
  const changed =
    stateChanged ||
    effects.refreshTokens > 0 ||
    effects.accessTokens > 0 ||
    revokedGrantContexts.length > 0;
  const grantEffectsEventId = await auditGrantEffects(
    context,
    existing,
    revokedGrantContexts,
    { action: "client.grants_revoked", revokedTokens },
  );
  await recordCommandEvent(context, {
    organizationId: row.organizationId,
    targetType: "client",
    targetId: clientId,
    action: changed
      ? disabled
        ? "client.disabled"
        : "client.enabled"
      : "client.state_unchanged",
    data: {
      before: auditClient(existing),
      after: auditClient(row),
      effects,
      ...(grantEffectsEventId ? { grantEffectsEventId } : {}),
    },
  });
  return { client: publicClient(row), changed };
}
export async function disableClient(
  context: PlatformWriteContext,
  clientId: string,
) {
  return setDisabled(context, clientId, true);
}
export async function enableClient(
  context: PlatformWriteContext,
  clientId: string,
) {
  return setDisabled(context, clientId, false);
}
export async function rotateSecret(
  context: PlatformWriteContext,
  clientId: string,
) {
  const existing = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  if (existing.tokenEndpointAuthMethod !== "client_secret_basic")
    throw new ProblemError(
      409,
      "client_has_no_secret",
      "Client does not use a shared secret",
    );
  const clientSecret = generateClientSecret();
  const updated = (await queries.setClientSecret(
    context,
    clientId,
    hashClientSecret(clientSecret),
  ))!;
  const { revokedTokens, ...tokens } = await revokeClientTokens(
    context,
    clientId,
  );
  const revokedGrantContexts = await revokeClientGrantContexts(
    context,
    existing.id,
  );
  const grantEffectsEventId = await auditGrantEffects(
    context,
    existing,
    revokedGrantContexts,
    { action: "client.grants_revoked", revokedTokens },
  );
  await recordCommandEvent(context, {
    organizationId: updated.organizationId,
    targetType: "client",
    targetId: clientId,
    action: "client.secret_rotated",
    data: {
      before: { authorizationVersion: existing.authorizationVersion },
      after: { authorizationVersion: updated.authorizationVersion },
      effects: {
        credentialChanged: existing.clientSecret !== updated.clientSecret,
        ...tokens,
      },
      ...(grantEffectsEventId ? { grantEffectsEventId } : {}),
    },
  });
  return { clientId, clientSecret };
}
export async function setOwner(
  context: PlatformWriteContext,
  clientId: string,
  organizationId: string | null,
) {
  const existing = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  if (existing.organizationId !== organizationId)
    throw new ProblemError(
      409,
      "ownership_conflict",
      "Client ownership is immutable; create a replacement client under the new owner",
    );
  await recordCommandEvent(context, {
    organizationId: existing.organizationId,
    targetType: "client",
    targetId: clientId,
    action: "client.owner_unchanged",
    data: {
      before: { organizationId },
      after: { organizationId },
      changed: false,
    },
  });
  return publicClient(existing);
}
export async function linkResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const client = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  const target = found(
    await lockResourceForCommand(context, resource),
    notFound,
  );
  const result = await queries.linkClientResource(context, clientId, resource);
  await auditResourceLink(
    context,
    client,
    resource,
    target,
    !result.created,
    true,
    result.relationship,
  );
  return { created: result.created };
}
export async function unlinkResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const client = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  const target = await readResourceForPolicy(context, resource);
  const removed = await queries.unlinkClientResource(
    context,
    clientId,
    resource,
  );
  await auditResourceLink(
    context,
    client,
    resource,
    target,
    removed !== null,
    false,
    removed,
  );
  return { removed: removed !== null };
}

export async function eraseClient(
  context: PlatformWriteContext,
  clientId: string,
  confirm: string,
) {
  const existing = found(
    await queries.lockClientForCommand(context, clientId),
    notFound,
  );
  if (confirm !== clientId)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the client ID",
    );
  if (await queries.countClientEntitlements(context, clientId))
    throw new ProblemError(
      409,
      "client_has_entitlements",
      "Remove the client's entitlements before erasure",
    );
  await requireNoCapabilityReferences(context, { clientId });
  const revokedGrantContexts = await revokeClientGrantContexts(
    context,
    existing.id,
  );
  const { row, effects } = await queries.deleteClient(context, clientId);
  const grantEffectsEventId = await auditGrantEffects(
    context,
    existing,
    revokedGrantContexts,
    { action: "client.grants_erased", effects },
  );
  await recordCommandEvent(context, {
    organizationId: existing.organizationId,
    targetType: "client",
    targetId: clientId,
    action: "client.erased",
    data: {
      deletionMode: "soft",
      effects: {
        accessTokens: effects.deletedAccessTokens.length,
        refreshTokens: effects.deletedRefreshTokens.length,
        consents: effects.softDeletedConsents.length,
        resourceLinks: effects.softDeletedClientResources.length,
        grantContexts: revokedGrantContexts.length,
      },
      before: auditClient(existing),
      after: auditClient(row),
      ...(grantEffectsEventId ? { grantEffectsEventId } : {}),
    },
  });
}
