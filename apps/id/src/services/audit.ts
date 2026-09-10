import { type TenantReadContext } from "./tenant-context.ts";
import { userExists } from "../db/queries/users.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import * as queries from "../db/queries/audit.ts";
import { organizationExistsForHistory } from "../db/queries/organizations.ts";
import type { PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";

export function listAuditEvents(
  context: PlatformReadContext,
  filters: queries.AuditEventFilters,
  page: PageQuery,
) {
  return queries.listAuditEvents(context, filters, page);
}

export async function listOrganizationAuditEvents(
  context: TenantReadContext<"history">,
  filters: Omit<queries.AuditEventFilters, "organizationId">,
  page: PageQuery,
) {
  if (
    !(await organizationExistsForHistory(context)) &&
    !(await queries.listOrganizationAuditEvents(context, {}, { limit: 1 }))
      .items.length
  ) {
    throw new ProblemError(404, "not_found", "Organisation not found");
  }
  return queries.listOrganizationAuditEvents(context, filters, page);
}

export async function listUserAuditEvents(
  context: PlatformReadContext,
  userId: string,
  filters: Pick<
    queries.AuditEventFilters,
    "action" | "outcome" | "from" | "to"
  >,
  page: PageQuery,
) {
  if (
    !(await userExists(context, userId)) &&
    !(await queries.listUserAuditEvents(context, userId, {}, { limit: 1 }))
      .items.length
  )
    throw new ProblemError(404, "not_found", "User not found");
  return queries.listUserAuditEvents(context, userId, filters, page);
}
