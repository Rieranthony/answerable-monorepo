import { revokeClientGrantContexts } from "../db/queries/grant-contexts.ts";
import { requireNoCapabilityReferences } from "./capabilities.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/oauth-clients.ts";
import {
  lockResourceForCommand,
  readResourceForPolicy,
} from "../db/queries/oauth-resources.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { revokeClientTokens } from "../db/queries/oauth-tokens.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
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
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "Client, resource or organisation not found",
    );
  return row;
}
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
function audit(
  tx: Executor,
  actor: Actor,
  clientId: string,
  action: string,
  data: Record<string, unknown>,
  organizationId?: string | null,
  schemaVersion: 1 | 2 | 3 = 1,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    schemaVersion,
    targetType: "client",
    targetId: clientId,
    action,
    outcome: "success",
    data,
  });
}
/** Owning a client does not grant visibility into another tenant's private target. */
function auditResourceLink(
  tx: Executor,
  actor: Actor,
  client: ClientRow,
  identifier: string,
  resource: Awaited<ReturnType<typeof readResourceForPolicy>>,
  before: boolean,
  after: boolean,
  relationship: { id: string; deletedAt: Date | null } | null,
) {
  return audit(
    tx,
    actor,
    client.clientId,
    before === after
      ? "client.resource_unchanged"
      : after
        ? "client.resource_linked"
        : "client.resource_unlinked",
    {
      resource: identifier,
      relationship,
      resourceInstanceId: resource?.id ?? null,
      resourceClassification: resource?.classification ?? null,
      resourceOrganizationId: resource?.organizationId ?? null,
      before: { linked: before },
      after: { linked: after },
    },
    resource?.classification === "platform_shared" ||
      resource?.organizationId === client.organizationId
      ? client.organizationId
      : null,
    3,
  );
}
/** A client's owner is not entitled to its other tenants' grant identities. */
async function auditGrantEffects(
  tx: Executor,
  actor: Actor,
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
  const event = await audit(
    tx,
    actor,
    client.clientId,
    action,
    {
      clientInstanceId: client.id,
      grantContexts,
      ...payload,
      ...(action === "client.grants_erased" ? { deletionMode: "soft" } : {}),
    },
    null,
    action === "client.grants_erased" ? 3 : 2,
  );
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
  return cursorPage(await queries.listClients(context, query), query.limit);
}
export async function getClient(
  context: PlatformReadContext,
  clientId: string,
) {
  // Keep the registration and its linked resources on the same revision.
  const row = requireRow(await queries.readClient(context, clientId));
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
  const { tx, actor } = requirePlatformWriteContext(context);
  validateClient(input);
  if (input.organizationId)
    requireRow(await lockOrganizationForCommand(context, input.organizationId));
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
  await audit(
    tx,
    actor,
    clientId,
    "client.created",
    { before: null, after: auditClient(row) },
    row.organizationId,
  );
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
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireRow(
    await queries.lockClientForCommand(context, clientId),
  );
  if (
    expected &&
    (existing.id !== expected.id || existing.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
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
  await audit(
    tx,
    actor,
    clientId,
    changed ? "client.updated" : "client.update_unchanged",
    {
      requestedFields: Object.keys(patch).sort(),
      before: auditClient(existing),
      after: auditClient(row!),
    },
    row!.organizationId,
  );
  return publicClient(row!);
}
async function setDisabled(
  context: PlatformWriteContext,
  clientId: string,
  disabled: boolean,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireRow(
    await queries.lockClientForCommand(context, clientId),
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
    tx,
    actor,
    existing,
    revokedGrantContexts,
    { action: "client.grants_revoked", revokedTokens },
  );
  await audit(
    tx,
    actor,
    clientId,
    changed
      ? disabled
        ? "client.disabled"
        : "client.enabled"
      : "client.state_unchanged",
    {
      before: auditClient(existing),
      after: auditClient(row),
      effects,
      ...(grantEffectsEventId ? { grantEffectsEventId } : {}),
    },
    row.organizationId,
  );
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
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireRow(
    await queries.lockClientForCommand(context, clientId),
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
    tx,
    actor,
    existing,
    revokedGrantContexts,
    { action: "client.grants_revoked", revokedTokens },
  );
  await audit(
    tx,
    actor,
    clientId,
    "client.secret_rotated",
    {
      before: { authorizationVersion: existing.authorizationVersion },
      after: { authorizationVersion: updated.authorizationVersion },
      effects: {
        credentialChanged: existing.clientSecret !== updated.clientSecret,
        ...tokens,
      },
      ...(grantEffectsEventId ? { grantEffectsEventId } : {}),
    },
    updated.organizationId,
  );
  return { clientId, clientSecret };
}
export async function setOwner(
  context: PlatformWriteContext,
  clientId: string,
  organizationId: string | null,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireRow(
    await queries.lockClientForCommand(context, clientId),
  );
  if (existing.organizationId !== organizationId)
    throw new ProblemError(
      409,
      "ownership_conflict",
      "Client ownership is immutable; create a replacement client under the new owner",
    );
  await audit(
    tx,
    actor,
    clientId,
    "client.owner_unchanged",
    {
      before: { organizationId },
      after: { organizationId },
      changed: false,
    },
    existing.organizationId,
  );
  return publicClient(existing);
}
export async function linkResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const client = requireRow(
    await queries.lockClientForCommand(context, clientId),
  );
  const target = requireRow(await lockResourceForCommand(context, resource));
  const result = await queries.linkClientResource(context, clientId, resource);
  await auditResourceLink(
    tx,
    actor,
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
  const { tx, actor } = requirePlatformWriteContext(context);
  const client = requireRow(
    await queries.lockClientForCommand(context, clientId),
  );
  const target = await readResourceForPolicy(context, resource);
  const removed = await queries.unlinkClientResource(
    context,
    clientId,
    resource,
  );
  await auditResourceLink(
    tx,
    actor,
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
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireRow(
    await queries.lockClientForCommand(context, clientId),
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
    tx,
    actor,
    existing,
    revokedGrantContexts,
    { action: "client.grants_erased", effects },
  );
  await recordAuditEvent(tx, {
    ...actor,
    organizationId: existing.organizationId,
    targetType: "client",
    targetId: clientId,
    action: "client.erased",
    outcome: "success",
    schemaVersion: 3,
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
