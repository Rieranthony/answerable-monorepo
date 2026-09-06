import * as queries from "../db/queries/members.ts";
import type { MemberWindow } from "../db/queries/groups.ts";
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
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "Organisation or member not found",
    );
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
    targetType: "member",
    action,
    data,
    outcome: "success",
  });
}
export async function listMembers(
  db: Database,
  organizationId: string,
  query: queries.MemberQuery,
) {
  requireRow(await findOrganization(db, organizationId));
  return cursorPage(
    await queries.listMembers(db, organizationId, query),
    query.limit,
  );
}
export async function getMember(
  db: Database,
  organizationId: string,
  memberId: string,
) {
  return requireRow(await queries.findMember(db, organizationId, memberId));
}
export function updateWindow(
  db: Database,
  actor: Actor,
  organizationId: string,
  memberId: string,
  patch: MemberWindow,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const row = requireRow(
      await queries.updateMemberWindow(tx, organizationId, memberId, patch),
    );
    await audit(tx, actor, organizationId, memberId, "member.updated", {
      changes: patch,
    });
    return row;
  });
}
export function remove(
  db: Database,
  actor: Actor,
  organizationId: string,
  memberId: string,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const row = requireRow(
      await queries.removeMember(tx, organizationId, memberId),
    );
    await audit(tx, actor, organizationId, memberId, "member.removed", {
      userId: row.userId,
    });
  });
}
