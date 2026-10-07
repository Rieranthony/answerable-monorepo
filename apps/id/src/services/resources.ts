import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { eq } from "drizzle-orm";
import { oauthResources, systemBindings } from "../db/schema/index.ts";
import { revokeResourceGrantContexts } from "../db/queries/grant-contexts.ts";
import { requireNoCapabilityReferences } from "./capabilities.ts";
import {
  type PlatformWriteContext,
  type PlatformReadContext,
} from "./platform-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/oauth-resources.ts";
import { recordCommandEvent } from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";

type ResourceRow = NonNullable<
  Awaited<ReturnType<typeof queries.readResource>>
>;
function auditResource(row: ResourceRow) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    identifier: row.identifier,
    classification: row.classification,
    organizationId: row.organizationId,
    name: row.name,
    revision: row.revision,
    accessTokenTtl: row.accessTokenTtl,
    refreshTokenTtl: row.refreshTokenTtl,
    allowedScopes: row.allowedScopes,
    signingAlgorithm: row.signingAlgorithm,
    disabled: row.disabled,
  };
}
const notFound = "Resource not found";
async function protect(tx: Executor, resourceId: string) {
  const [binding] = await tx
    .select({ resourceId: systemBindings.resourceInstanceId })
    .from(systemBindings)
    .where(eq(systemBindings.resourceInstanceId, resourceId));
  if (binding)
    throw new ProblemError(
      409,
      "resource_protected",
      "The bound admin resource is protected",
    );
}
export async function listResources(
  context: PlatformReadContext,
  query: queries.ResourceQuery,
) {
  return queries.listResources(context, query);
}
export async function getResource(
  context: PlatformReadContext,
  identifier: string,
) {
  const row = found(await queries.readResource(context, identifier), notFound);
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
  const row = await queries.createResource(context, input);
  await recordCommandEvent(context, {
    targetType: "resource",
    targetId: row.identifier,
    action: "resource.created",
    data: {
      before: null,
      after: auditResource(row),
    },
  });
  return row;
}
export async function updateResource(
  context: PlatformWriteContext,
  identifier: string,
  patch: queries.ResourcePatch,
  expected?: { id: string; revision: number },
) {
  const { tx } = context;
  // Preserve root admission ordering when this resource can activate platform authority.
  if (patch.allowedScopes !== undefined) {
    const [binding] = await tx
      .select({ organizationId: systemBindings.organizationId })
      .from(systemBindings)
      .innerJoin(
        oauthResources,
        eq(oauthResources.id, systemBindings.resourceInstanceId),
      )
      .where(eq(oauthResources.identifier, identifier));
    if (binding)
      await lockOrganizationForCommand(context, binding.organizationId);
  }
  const existing = found(
    await queries.lockResourceForCommand(context, identifier),
    notFound,
  );
  assertRevision(
    existing,
    expected,
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
  await recordCommandEvent(context, {
    targetType: "resource",
    targetId: identifier,
    action: changed ? "resource.updated" : "resource.update_unchanged",
    data: {
      requestedFields: Object.keys(patch).sort(),
      before: auditResource(existing),
      after: auditResource(row!),
    },
  });
  return { row: row!, changed };
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
  const { tx } = context;
  const existing = found(
    await queries.lockResourceForCommand(context, identifier),
    notFound,
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
  await recordCommandEvent(context, {
    targetType: "resource",
    targetId: identifier,
    action: changed
      ? disabled
        ? "resource.disabled"
        : "resource.enabled"
      : "resource.state_unchanged",
    data: {
      before: auditResource(existing),
      after: auditResource(row),
      effects: { revokedGrantContexts },
    },
  });
  return { row, changed };
}
export async function eraseResource(
  context: PlatformWriteContext,
  identifier: string,
  confirm: string,
) {
  const { tx } = context;
  const existing = found(
    await queries.lockResourceForCommand(context, identifier),
    notFound,
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
  const revokedGrantContexts = await revokeResourceGrantContexts(
    context,
    existing.id,
  );
  const row = await queries.deleteResource(context, identifier);
  await recordCommandEvent(context, {
    targetType: "resource",
    targetId: identifier,
    action: "resource.erased",
    data: {
      before: auditResource(existing),
      after: auditResource(row),
      deletionMode: "soft",
      revokedGrantContexts,
    },
  });
}
