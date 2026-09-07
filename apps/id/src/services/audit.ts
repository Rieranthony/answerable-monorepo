import { findUser } from "../db/queries/users.ts";
import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/audit.ts";
import { findOrganization } from "../db/queries/organizations.ts";
import type { PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";

export function listAuditEvents(
  db: Database,
  filters: queries.AuditEventFilters,
  page: PageQuery,
) {
  return queries.listAuditEvents(db, filters, page);
}

export async function listOrganizationAuditEvents(
  db: Database,
  organizationId: string,
  filters: Omit<queries.AuditEventFilters, "organizationId">,
  page: PageQuery,
) {
  if (!(await findOrganization(db, organizationId))) {
    throw new ProblemError(404, "not_found", "Organisation not found");
  }
  return listAuditEvents(db, { ...filters, organizationId }, page);
}

export async function listUserAuditEvents(
  db: Database,
  userId: string,
  filters: Pick<
    queries.AuditEventFilters,
    "action" | "outcome" | "from" | "to"
  >,
  page: PageQuery,
) {
  if (!(await findUser(db, userId)))
    throw new ProblemError(404, "not_found", "User not found");
  return queries.listUserAuditEvents(db, userId, filters, page);
}
