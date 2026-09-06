import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/oauth-resources.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { Environment } from "../env.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireResource<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Resource not found");
  return row;
}
function protect(
  identifier: string,
  environment: Pick<Environment, "adminResourceIdentifier">,
) {
  if (identifier === environment.adminResourceIdentifier)
    throw new ProblemError(
      409,
      "resource_protected",
      "The admin resource is protected",
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
  db: Database,
  query: queries.ResourceQuery,
) {
  return cursorPage(await queries.listResources(db, query), query.limit);
}
export async function getResource(db: Database, identifier: string) {
  return requireResource(await queries.findResource(db, identifier));
}
export function createResource(
  db: Database,
  actor: Actor,
  input: queries.ResourceInput,
) {
  return db.transaction(async (tx) => {
    const row = await queries.createResource(tx, input);
    await audit(tx, actor, row.identifier, "resource.created", { ...input });
    return row;
  });
}
export function updateResource(
  db: Database,
  actor: Actor,
  identifier: string,
  patch: queries.ResourcePatch,
) {
  return db.transaction(async (tx) => {
    requireResource(await queries.lockResource(tx, identifier));
    const row = await queries.updateResource(tx, identifier, patch);
    await audit(tx, actor, identifier, "resource.updated", { changes: patch });
    return row!;
  });
}
export function disableResource(
  db: Database,
  actor: Actor,
  identifier: string,
  environment: Pick<Environment, "adminResourceIdentifier">,
) {
  protect(identifier, environment);
  return setDisabled(db, actor, identifier, true);
}
export function enableResource(db: Database, actor: Actor, identifier: string) {
  return setDisabled(db, actor, identifier, false);
}
function setDisabled(
  db: Database,
  actor: Actor,
  identifier: string,
  disabled: boolean,
) {
  return db.transaction(async (tx) => {
    const existing = requireResource(
      await queries.lockResource(tx, identifier),
    );
    if (existing.disabled === disabled)
      throw new ProblemError(
        409,
        disabled ? "resource_already_disabled" : "resource_already_active",
        "Resource is already in the requested state",
      );
    const row = await queries.setResourceDisabled(tx, identifier, disabled);
    await audit(
      tx,
      actor,
      identifier,
      disabled ? "resource.disabled" : "resource.enabled",
      { disabled },
    );
    return row!;
  });
}
export function eraseResource(
  db: Database,
  actor: Actor,
  identifier: string,
  confirm: string,
  environment: Pick<Environment, "adminResourceIdentifier">,
) {
  if (confirm !== identifier)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the resource identifier",
    );
  protect(identifier, environment);
  return db.transaction(async (tx) => {
    requireResource(await queries.lockResource(tx, identifier));
    if (await queries.countResourceEntitlements(tx, identifier))
      throw new ProblemError(
        409,
        "resource_has_entitlements",
        "Remove the resource's entitlements before erasure",
      );
    await queries.deleteResource(tx, identifier);
    await audit(tx, actor, identifier, "resource.erased", {});
  });
}
