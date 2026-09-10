import {
  requireTenantMemberAccessContext,
  type TenantReadContext,
} from "./tenant-context.ts";
import * as queries from "../db/queries/access.ts";
import { findMemberConfiguration } from "../db/queries/members.ts";
import { findClientForAccess } from "../db/queries/oauth-clients.ts";
import { findResourceForAccess } from "../db/queries/oauth-resources.ts";
import type { PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
function requireRow<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Not found");
  return row;
}
export async function getMemberAccess(
  context: TenantReadContext<"memberAccess">,
  memberId: string,
) {
  requireTenantMemberAccessContext(context);
  requireRow(await findMemberConfiguration(context, memberId));
  return queries.memberAccess(context, memberId);
}
export async function listTargetAccess(
  context: TenantReadContext<"directory">,
  target: queries.AccessTarget,
  page: PageQuery,
) {
  if (target.clientId !== undefined)
    requireRow(await findClientForAccess(context, target.clientId));
  if (target.resource !== undefined)
    requireRow(await findResourceForAccess(context, target.resource));
  return queries.targetAccess(context, target, page);
}
