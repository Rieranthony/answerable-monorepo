import * as queries from "../db/queries/entitlements.ts";
import { findMember } from "../db/queries/members.ts";
import { findGroup } from "../db/queries/groups.ts";
import { findClient } from "../db/queries/oauth-clients.ts";
import { findResource } from "../db/queries/oauth-resources.ts";
import type { Database, Executor } from "../db/client.ts";
import {
  findOrganization,
  lockOrganization,
} from "../db/queries/organizations.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
function requireRow<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Not found");
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  targetId: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetId,
    targetType: "entitlement",
    action,
    data,
    outcome: "success",
  });
}
async function lockedEntitlement(
  tx: Executor,
  organizationId: string,
  entitlementId: string,
) {
  requireRow(await lockOrganization(tx, organizationId));
  return requireRow(
    await queries.findEntitlement(tx, organizationId, entitlementId),
  );
}
export async function listEntitlements(
  db: Database,
  organizationId: string,
  query: queries.EntitlementQuery,
) {
  requireRow(await findOrganization(db, organizationId));
  return cursorPage(
    await queries.listEntitlements(db, organizationId, query),
    query.limit,
  );
}
export async function getEntitlement(
  db: Database,
  organizationId: string,
  entitlementId: string,
) {
  return requireRow(
    await queries.findEntitlement(db, organizationId, entitlementId),
  );
}
export function createEntitlement(
  db: Database,
  actor: Actor,
  organizationId: string,
  input: Omit<queries.CreateEntitlementInput, "organizationId">,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    if (input.memberId !== undefined && input.groupId !== undefined)
      invalid("memberId", "At most one of memberId and groupId is allowed");
    if ((input.clientId !== undefined) === (input.resource !== undefined))
      invalid("clientId", "Exactly one of clientId and resource is required");
    if (input.memberId !== undefined)
      requireRow(await findMember(tx, organizationId, input.memberId));
    if (input.groupId !== undefined)
      requireRow(await findGroup(tx, organizationId, input.groupId));
    if (input.clientId !== undefined)
      requireRow(await findClient(tx, input.clientId));
    if (input.resource !== undefined)
      await checkScopes(tx, input.resource, input.scopes);
    const row = await queries.createEntitlement(tx, {
      ...input,
      organizationId,
    });
    await audit(tx, actor, organizationId, row.id, "entitlement.created", {
      memberId: row.memberId,
      groupId: row.groupId,
      clientId: row.clientId,
      resource: row.resource,
      scopes: row.scopes,
    });
    return row;
  });
}
export function updateEntitlement(
  db: Database,
  actor: Actor,
  organizationId: string,
  entitlementId: string,
  patch: queries.EntitlementPatch,
) {
  return db.transaction(async (tx) => {
    const existing = await lockedEntitlement(tx, organizationId, entitlementId);
    if (patch.scopes !== undefined && existing.resource !== null)
      await checkScopes(tx, existing.resource, patch.scopes);
    const row = await queries.updateEntitlement(
      tx,
      organizationId,
      entitlementId,
      patch,
    );
    await audit(
      tx,
      actor,
      organizationId,
      entitlementId,
      "entitlement.updated",
      {
        changes: patch,
      },
    );
    return row!;
  });
}
function setStatus(
  db: Database,
  actor: Actor,
  organizationId: string,
  entitlementId: string,
  status: "active" | "disabled",
) {
  return db.transaction(async (tx) => {
    const existing = await lockedEntitlement(tx, organizationId, entitlementId);
    if (existing.status === status)
      throw new ProblemError(
        409,
        `entitlement_already_${status}`,
        `Entitlement is already ${status}`,
      );
    const row = await queries.setEntitlementStatus(
      tx,
      organizationId,
      entitlementId,
      status,
    );
    await audit(
      tx,
      actor,
      organizationId,
      entitlementId,
      status === "active" ? "entitlement.enabled" : "entitlement.disabled",
      { status },
    );
    return row!;
  });
}
export function disableEntitlement(
  db: Database,
  actor: Actor,
  organizationId: string,
  entitlementId: string,
) {
  return setStatus(db, actor, organizationId, entitlementId, "disabled");
}
export function enableEntitlement(
  db: Database,
  actor: Actor,
  organizationId: string,
  entitlementId: string,
) {
  return setStatus(db, actor, organizationId, entitlementId, "active");
}
export function removeEntitlement(
  db: Database,
  actor: Actor,
  organizationId: string,
  entitlementId: string,
) {
  return db.transaction(async (tx) => {
    await lockedEntitlement(tx, organizationId, entitlementId);
    await queries.deleteEntitlement(tx, organizationId, entitlementId);
    await audit(
      tx,
      actor,
      organizationId,
      entitlementId,
      "entitlement.removed",
      {},
    );
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
async function checkScopes(tx: Executor, resource: string, scopes: string[]) {
  const row = requireRow(await findResource(tx, resource));
  const unknown = scopes.filter(
    (scope) => !(row.allowedScopes ?? []).includes(scope),
  );
  if (unknown.length)
    invalid(
      "scopes",
      `Scopes are not allowed for this resource: ${unknown.join(", ")}`,
    );
}
