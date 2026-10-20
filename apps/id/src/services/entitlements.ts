import { type PlatformWriteContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/entitlements.ts";
import { findMemberForAssignment } from "../db/queries/members.ts";
import { findGroupForCommand } from "../db/queries/groups.ts";
import { readClient } from "../db/queries/oauth-clients.ts";
import { readResourceForPolicy } from "../db/queries/oauth-resources.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import type { AuditAction } from "../db/queries/audit.ts";
import {
  type Evidence,
  evidence,
  recordCommandEvent,
  statusAction,
} from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";
import { uniqueSorted } from "../lib/scopes.ts";

type Configuration = Evidence<
  NonNullable<Awaited<ReturnType<typeof queries.findEntitlement>>>
>;
async function audit(
  context: PlatformWriteContext,
  action: AuditAction,
  data:
    | {
        before: Configuration;
        after: Configuration | null;
        deletionMode?: "soft";
      }
    | { before: null; after: Configuration; deletionMode?: "soft" },
) {
  const target = data.before ?? data.after;
  // A change names the memberships it reaches.
  const audience = await queries.readEntitlementAudience(
    context,
    target.organizationId,
    target,
  );
  return recordCommandEvent(context, {
    organizationId: target.organizationId,
    targetId: target.id,
    targetType: "entitlement",
    action,
    data: { ...data, audience },
  });
}
async function lockedEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  found(await lockOrganizationForCommand(context, organizationId));
  return found(
    await queries.findEntitlementForCommand(
      context,
      organizationId,
      entitlementId,
    ),
  );
}
export async function getEntitlement(
  context: TenantReadContext<"directory">,
  entitlementId: string,
) {
  return found(await queries.findEntitlement(context, entitlementId));
}
export async function createEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  input: Omit<queries.CreateEntitlementInput, "organizationId">,
) {
  found(await lockOrganizationForCommand(context, organizationId));
  if (input.memberId !== undefined && input.groupId !== undefined)
    invalid("memberId", "At most one of memberId and groupId is allowed");
  if (input.clientId === undefined && input.resource === undefined)
    invalid("clientId", "A client, resource or exact pair is required");
  if (input.memberId !== undefined) {
    const member = found(
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
    found(await findGroupForCommand(context, organizationId, input.groupId));
  if (input.clientId !== undefined)
    found(await readClient(context, input.clientId));
  if (input.resource !== undefined)
    await checkScopes(context, input.resource, input.scopes);
  const row = await queries.createEntitlement(context, {
    ...input,
    organizationId,
  });
  await audit(context, "entitlement.created", {
    before: null,
    after: evidence(row),
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
  const existing = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  assertRevision(
    existing,
    expected,
    "Entitlement changed; read its current revision before issuing a new command",
  );
  if (patch.scopes !== undefined && existing.resource !== null)
    await checkScopes(context, existing.resource, patch.scopes);
  const changed =
    (patch.scopes !== undefined &&
      JSON.stringify(patch.scopes) !==
        JSON.stringify(uniqueSorted(existing.scopes))) ||
    (patch.validFrom !== undefined &&
      patch.validFrom?.getTime() !== existing.validFrom?.getTime()) ||
    (patch.validUntil !== undefined &&
      patch.validUntil?.getTime() !== existing.validUntil?.getTime());
  const row = changed
    ? (await queries.updateEntitlement(
        context,
        organizationId,
        entitlementId,
        patch,
      ))!
    : existing;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed)
    await audit(context, "entitlement.updated", {
      before: evidence(existing),
      after: evidence(row),
    });
  return { row, changed };
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
  status: "active" | "disabled",
) {
  const existing = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  const changed = existing.status !== status;
  const row = changed
    ? (await queries.setEntitlementStatus(
        context,
        organizationId,
        entitlementId,
        status,
      ))!
    : existing;
  if (changed)
    await audit(context, statusAction("entitlement", status), {
      before: evidence(existing),
      after: evidence(row),
    });
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
  const before = await lockedEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  const row = await queries.deleteEntitlement(
    context,
    organizationId,
    entitlementId,
  );
  await audit(context, "entitlement.removed", {
    before: evidence(before),
    after: evidence(row!),
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
  const row = found(await readResourceForPolicy(context, resource));
  const unknown = scopes.filter(
    (scope) => !(row.allowedScopes ?? []).includes(scope),
  );
  if (unknown.length)
    invalid(
      "scopes",
      `Scopes are not allowed for this resource: ${unknown.join(", ")}`,
    );
}
