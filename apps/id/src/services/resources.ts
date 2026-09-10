import { eq } from "drizzle-orm";
import { oauthResources, systemBindings } from "../db/schema/index.ts";
import { platformWriterCheck } from "./platform-writer.ts";
import {
  revokeResourceGrantContexts,
  deleteResourceGrantContexts,
} from "../db/queries/grant-contexts.ts";
import { requireNoCapabilityReferences } from "./capabilities.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/oauth-resources.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

type ResourceRow = NonNullable<
  Awaited<ReturnType<typeof queries.readResource>>
>;
function auditResource(row: ResourceRow) {
  return {
    id: row.id,
    identifier: row.identifier,
    classification: row.classification,
    organizationId: row.organizationId,
    name: row.name,
    revision: row.revision,
    accessTokenTtl: row.accessTokenTtl,
    refreshTokenTtl: row.refreshTokenTtl,
    allowedScopes: row.allowedScopes,
    signingAlgorithm: row.signingAlgorithm,
    signingKeyId: row.signingKeyId,
    disabled: row.disabled,
    policyVersion: row.policyVersion,
    dpopBoundAccessTokensRequired: row.dpopBoundAccessTokensRequired,
  };
}
function requireResource<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Resource not found");
  return row;
}
async function protect(tx: Executor, resourceId: string) {
  const [binding] = await tx
    .select({ resourceId: systemBindings.resourceId })
    .from(systemBindings)
    .where(eq(systemBindings.resourceId, resourceId));
  if (binding)
    throw new ProblemError(
      409,
      "resource_protected",
      "The bound admin resource is protected",
    );
}
function audit(
  tx: Executor,
  actor: Actor,
  identifier: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    targetType: "resource",
    targetId: identifier,
    action,
    outcome: "success",
    data,
  });
}
export async function listResources(
  context: PlatformReadContext,
  query: queries.ResourceQuery,
) {
  return cursorPage(await queries.listResources(context, query), query.limit);
}
export async function getResource(
  context: PlatformReadContext,
  identifier: string,
) {
  const row = requireResource(await queries.readResource(context, identifier));
  return {
    ...row,
    clients: (await queries.listResourceClients(context, identifier))
      .map((link) => link.clientId)
      .sort(),
  };
}
export async function createResource(
  context: PlatformWriteContext,
  input: queries.ResourceInput,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const row = await queries.createResource(context, input);
  await audit(tx, actor, row.identifier, "resource.created", {
    before: null,
    after: auditResource(row),
  });
  return row;
}
export async function updateResource(
  context: PlatformWriteContext,
  identifier: string,
  patch: queries.ResourcePatch,
  expected?: { id: string; revision: number },
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  // Scope changes to the bound resource use the platform organisation lock
  // before the resource lock, matching other administrative policy writers.
  let checkWriter: (() => Promise<void>) | undefined;
  if (patch.allowedScopes !== undefined) {
    const [binding] = await tx
      .select({ organizationId: systemBindings.organizationId })
      .from(systemBindings)
      .innerJoin(
        oauthResources,
        eq(oauthResources.id, systemBindings.resourceId),
      )
      .where(eq(oauthResources.identifier, identifier));
    if (binding)
      checkWriter = await platformWriterCheck(tx, binding.organizationId);
  }
  const existing = requireResource(
    await queries.lockResourceForCommand(context, identifier),
  );
  if (
    expected &&
    (existing.id !== expected.id || existing.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Resource changed; read its current revision before issuing a new command",
    );
  const changed = Object.entries(patch).some(
    ([key, value]) =>
      value !== undefined &&
      JSON.stringify(value) !==
        JSON.stringify(existing[key as keyof ResourceRow]),
  );
  const row = changed
    ? await queries.updateResource(context, identifier, patch)
    : existing;
  await checkWriter?.();
  await audit(
    tx,
    actor,
    identifier,
    changed ? "resource.updated" : "resource.update_unchanged",
    {
      requestedFields: Object.keys(patch).sort(),
      before: auditResource(existing),
      after: auditResource(row!),
    },
  );
  return row!;
}
export async function disableResource(
  context: PlatformWriteContext,
  identifier: string,
) {
  return setDisabled(context, identifier, true);
}
export async function enableResource(
  context: PlatformWriteContext,
  identifier: string,
) {
  return setDisabled(context, identifier, false);
}
async function setDisabled(
  context: PlatformWriteContext,
  identifier: string,
  disabled: boolean,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireResource(
    await queries.lockResourceForCommand(context, identifier),
  );
  if (disabled) await protect(tx, existing.id);
  const stateChanged = existing.disabled !== disabled;
  const row = stateChanged
    ? (await queries.setResourceDisabled(context, identifier, disabled))!
    : existing;
  const revokedGrantContexts = disabled
    ? await revokeResourceGrantContexts(context, existing.id)
    : [];
  const changed = stateChanged || revokedGrantContexts.length > 0;
  await audit(
    tx,
    actor,
    identifier,
    changed
      ? disabled
        ? "resource.disabled"
        : "resource.enabled"
      : "resource.state_unchanged",
    {
      before: auditResource(existing),
      after: auditResource(row),
      effects: { revokedGrantContexts },
    },
  );
  return { resource: row, changed };
}
export async function eraseResource(
  context: PlatformWriteContext,
  identifier: string,
  confirm: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireResource(
    await queries.lockResourceForCommand(context, identifier),
  );
  if (confirm !== identifier)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the resource identifier",
    );
  await protect(tx, existing.id);
  if (await queries.countResourceEntitlements(context, identifier))
    throw new ProblemError(
      409,
      "resource_has_entitlements",
      "Remove the resource's entitlements before erasure",
    );
  if (await queries.hasResourceClients(context, identifier))
    throw new ProblemError(
      409,
      "resource_has_clients",
      "Unlink the resource from its clients before erasure",
    );
  await requireNoCapabilityReferences(context, { resource: identifier });
  const deletedGrantContexts = await deleteResourceGrantContexts(
    context,
    existing.id,
  );
  await queries.deleteResource(context, identifier);
  await audit(tx, actor, identifier, "resource.erased", {
    before: auditResource(existing),
    after: null,
    deletedGrantContexts,
  });
}
