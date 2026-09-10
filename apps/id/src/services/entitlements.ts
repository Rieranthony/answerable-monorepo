import { platformWriterCheck } from "./platform-writer.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/entitlements.ts";
import { findMemberForAssignment } from "../db/queries/members.ts";
import { findGroupForCommand } from "../db/queries/groups.ts";
import { readClientForPolicy } from "../db/queries/oauth-clients.ts";
import { readResourceForPolicy } from "../db/queries/oauth-resources.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
function requireRow<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Not found");
  return row;
}
function configuration(
  row: NonNullable<Awaited<ReturnType<typeof queries.findEntitlement>>>,
) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    revision: row.revision,
    organizationId: row.organizationId,
    memberId: row.memberId,
    groupId: row.groupId,
    clientId: row.clientId,
    resource: row.resource,
    scopes: row.scopes,
    status: row.status,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}
const scopeSet = (scopes: string[]) => [...new Set(scopes)].sort();
type Configuration = ReturnType<typeof configuration>;
async function audit(
  context: PlatformWriteContext,
  action: string,
  data:
    | {
        before: Configuration;
        after: Configuration | null;
        deletionMode?: "soft";
      }
    | { before: null; after: Configuration; deletionMode?: "soft" },
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const target = data.before ?? data.after;
  const captureAudience =
    target.memberId === null && !action.endsWith("_unchanged");
  const audience = captureAudience
    ? await queries.readEntitlementAudience(
        context,
        target.organizationId,
        target.groupId,
      )
    : undefined;
  return recordAuditEvent(tx, {
    ...actor,
    organizationId: target.organizationId,
    targetId: target.id,
    targetType: "entitlement",
    action,
    schemaVersion: data.deletionMode === "soft" ? 3 : captureAudience ? 2 : 1,
    data: { ...data, ...(captureAudience ? { audience } : {}) },
    outcome: "success",
  });
}
async function lockedEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  requireRow(await lockOrganizationForCommand(context, organizationId));
  return requireRow(
    await queries.findEntitlementForCommand(
      context,
      organizationId,
      entitlementId,
    ),
  );
}
export async function listEntitlements(
  context: TenantReadContext<"directory">,
  query: queries.EntitlementQuery,
) {
  return cursorPage(
    await queries.listEntitlements(context, query),
    query.limit,
  );
}
export async function getEntitlement(
  context: TenantReadContext<"directory">,
  entitlementId: string,
) {
  return requireRow(await queries.findEntitlement(context, entitlementId));
}
export async function createEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  input: Omit<queries.CreateEntitlementInput, "organizationId">,
) {
  requireRow(await lockOrganizationForCommand(context, organizationId));
  if (input.memberId !== undefined && input.groupId !== undefined)
    invalid("memberId", "At most one of memberId and groupId is allowed");
  if (input.clientId === undefined && input.resource === undefined)
    invalid("clientId", "A client, resource or exact pair is required");
  if (input.memberId !== undefined) {
    const member = requireRow(
      await findMemberForAssignment(context, organizationId, input.memberId),
    );
    if (member.membershipStatus === "revoked")
      throw new ProblemError(
        409,
        "membership_revoked",
        "Reinstate the membership before assigning access",
      );
  }
  if (input.groupId !== undefined)
    requireRow(
      await findGroupForCommand(context, organizationId, input.groupId),
    );
  if (input.clientId !== undefined)
    requireRow(await readClientForPolicy(context, input.clientId));
  if (input.resource !== undefined)
    await checkScopes(context, input.resource, input.scopes);
  const row = await queries.createEntitlement(context, {
    ...input,
    scopes: scopeSet(input.scopes),
    organizationId,
  });
  await audit(context, "entitlement.created", {
    before: null,
    after: configuration(row),
  });
  return row;
}
export async function updateEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
  patch: queries.EntitlementPatch,
  expected?: { id: string; revision: number },
) {
  const { tx } = requirePlatformWriteContext(context);
  const existing = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  if (
    expected &&
    (existing.id !== expected.id || existing.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Entitlement changed; read its current revision before issuing a new command",
    );
  if (patch.scopes !== undefined && existing.resource !== null)
    await checkScopes(context, existing.resource, patch.scopes);
  const normalized = {
    ...patch,
    ...(patch.scopes === undefined ? {} : { scopes: scopeSet(patch.scopes) }),
  };
  const changed =
    (normalized.scopes !== undefined &&
      JSON.stringify(normalized.scopes) !==
        JSON.stringify(scopeSet(existing.scopes))) ||
    (patch.validFrom !== undefined &&
      patch.validFrom?.getTime() !== existing.validFrom?.getTime()) ||
    (patch.validUntil !== undefined &&
      patch.validUntil?.getTime() !== existing.validUntil?.getTime());
  const checkWriter = await platformWriterCheck(tx, organizationId);
  const row = changed
    ? (await queries.updateEntitlement(
        context,
        organizationId,
        entitlementId,
        normalized,
      ))!
    : existing;
  await checkWriter();
  await audit(
    context,
    changed ? "entitlement.updated" : "entitlement.update_unchanged",
    { before: configuration(existing), after: configuration(row) },
  );
  return { row, changed };
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
  status: "active" | "disabled",
) {
  const { tx } = requirePlatformWriteContext(context);
  const existing = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  const changed = existing.status !== status;
  const checkWriter = await platformWriterCheck(tx, organizationId);
  const row = changed
    ? (await queries.setEntitlementStatus(
        context,
        organizationId,
        entitlementId,
        status,
      ))!
    : existing;
  await checkWriter();
  await audit(
    context,
    changed
      ? status === "active"
        ? "entitlement.enabled"
        : "entitlement.disabled"
      : status === "active"
        ? "entitlement.enable_unchanged"
        : "entitlement.disable_unchanged",
    { before: configuration(existing), after: configuration(row) },
  );
  return { row, changed };
}
export async function disableEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  return setStatus(context, organizationId, entitlementId, "disabled");
}
export async function enableEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  return setStatus(context, organizationId, entitlementId, "active");
}
export async function removeEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const before = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  const checkWriter = await platformWriterCheck(tx, organizationId);
  const row = await queries.deleteEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  await checkWriter();
  await audit(context, "entitlement.removed", {
    before: configuration(before),
    after: configuration(row!),
    deletionMode: "soft",
  });
}

function invalid(path: string, message: string): never {
  throw new ProblemError(
    400,
    "validation_failed",
    "The request is invalid",
    undefined,
    { errors: [{ path, message }] },
  );
}
async function checkScopes(
  context: PlatformWriteContext,
  resource: string,
  scopes: string[],
) {
  const row = requireRow(await readResourceForPolicy(context, resource));
  const unknown = scopes.filter(
    (scope) => !(row.allowedScopes ?? []).includes(scope),
  );
  if (unknown.length)
    invalid(
      "scopes",
      `Scopes are not allowed for this resource: ${unknown.join(", ")}`,
    );
}

export async function listAllEntitlements(
  context: PlatformReadContext,
  query: queries.EntitlementQuery,
) {
  return cursorPage(
    await queries.listAllEntitlements(context, query),
    query.limit,
  );
}
