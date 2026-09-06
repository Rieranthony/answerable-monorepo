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
