import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/organizations.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { deleteUserSessions } from "../db/queries/sessions.ts";
import {
  revokeUserTokens,
  revokeClientTokens,
} from "../db/queries/oauth-tokens.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireOrganization<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Organisation not found");
  return row;
}

function audit(
  executor: Executor,
  actor: Actor,
  id: string,
  action: string,
  data: Record<string, unknown>,
  erased = false,
) {
  return recordAuditEvent(executor, {
    ...actor,
    organizationId: erased ? null : id,
    action,
    targetType: "organization",
    targetId: id,
    outcome: "success",
    data,
  });
}

export async function listOrganizations(
  db: Database,
  query: queries.OrganizationQuery,
) {
  return cursorPage(await queries.listOrganizations(db, query), query.limit);
}

export async function getOrganization(db: Database, id: string) {
  return requireOrganization(await queries.findOrganization(db, id));
}

export function createOrganization(
  db: Database,
  actor: Actor,
  input: queries.OrganizationInput,
) {
  return db.transaction(async (tx) => {
    const row = await queries.createOrganization(tx, input);
    await audit(tx, actor, row.id, "organization.created", { ...input });
    return row;
  });
}

export function updateOrganization(
  db: Database,
  actor: Actor,
  id: string,
  patch: queries.OrganizationPatch,
) {
  return db.transaction(async (tx) => {
    requireOrganization(await queries.lockOrganization(tx, id));
    const row = await queries.updateOrganization(tx, id, patch);
    await audit(tx, actor, id, "organization.updated", { changes: patch });
    return row!;
  });
}

export function disableOrganization(db: Database, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const existing = requireOrganization(
      await queries.lockOrganization(tx, id),
    );
    if (existing.status === "disabled")
      throw new ProblemError(
        409,
        "organization_already_disabled",
        "Organisation is already disabled",
      );
    const row = await queries.setOrganizationStatus(tx, id, "disabled");
    const userIds = await queries.listOrganizationMemberUserIds(tx, id);
    const clientIds = await queries.listOrganizationClientIds(tx, id);
    const sessions = await deleteUserSessions(tx, userIds);
    const userTokens = await revokeUserTokens(tx, userIds);
    const clientTokens = await revokeClientTokens(tx, clientIds);
    await audit(tx, actor, id, "organization.disabled", {
      sessions,
      refreshTokens: userTokens.refreshTokens + clientTokens.refreshTokens,
      accessTokens: userTokens.accessTokens + clientTokens.accessTokens,
    });
    return row!;
  });
}

export function enableOrganization(db: Database, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const existing = requireOrganization(
      await queries.lockOrganization(tx, id),
    );
    if (existing.status === "active")
      throw new ProblemError(
        409,
        "organization_already_active",
        "Organisation is already active",
      );
    const row = await queries.setOrganizationStatus(tx, id, "active");
    await audit(tx, actor, id, "organization.enabled", { status: "active" });
    return row!;
  });
}

export function eraseOrganization(
  db: Database,
  actor: Actor,
  id: string,
  confirm: string,
) {
  if (confirm !== id)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the organisation ID",
    );
  return db.transaction(async (tx) => {
    requireOrganization(await queries.lockOrganization(tx, id));
    if (await queries.countOrganizationClients(tx, id))
      throw new ProblemError(
        409,
        "organization_has_clients",
        "Remove the organisation's clients before erasure",
      );
    await queries.deleteOrganization(tx, id);
    await audit(tx, actor, id, "organization.erased", {}, true);
  });
}
