import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/access.ts";
import { findOrganization } from "../db/queries/organizations.ts";
import { findMember } from "../db/queries/members.ts";
import { findClient } from "../db/queries/oauth-clients.ts";
import { findResource } from "../db/queries/oauth-resources.ts";
import type { PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
function requireRow<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Not found");
  return row;
}
export async function getMemberAccess(
  db: Database,
  organizationId: string,
  memberId: string,
) {
  requireRow(await findOrganization(db, organizationId));
  requireRow(await findMember(db, organizationId, memberId));
  return queries.memberAccess(db, organizationId, memberId);
}
export async function listTargetAccess(
  db: Database,
  organizationId: string,
  target: queries.AccessTarget,
  page: PageQuery,
) {
  requireRow(await findOrganization(db, organizationId));
  requireRow(
    "clientId" in target
      ? await findClient(db, target.clientId)
      : await findResource(db, target.resource),
  );
  return queries.targetAccess(db, organizationId, target, page);
}
