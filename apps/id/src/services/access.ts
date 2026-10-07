import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/access.ts";
import { findMemberConfiguration } from "../db/queries/members.ts";
import { findClientForAccess } from "../db/queries/oauth-clients.ts";
import { findResourceForAccess } from "../db/queries/oauth-resources.ts";
import type { PageQuery } from "../http/pagination.ts";
import { found } from "../http/problem.ts";
export async function getMemberAccess(
  context: TenantReadContext<"memberAccess">,
  memberId: string,
) {
  found(await findMemberConfiguration(context, memberId));
  return queries.memberAccess(context, memberId);
}
export async function listTargetAccess(
  context: TenantReadContext<"directory">,
  target: queries.AccessTarget,
  page: PageQuery,
) {
  if (target.clientId !== undefined)
    found(await findClientForAccess(context, target.clientId));
  if (target.resource !== undefined)
    found(await findResourceForAccess(context, target.resource));
  return queries.targetAccess(context, target, page);
}
