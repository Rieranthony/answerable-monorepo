import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/organization-domains.ts";
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
      "Organisation or domain not found",
    );
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  id: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetType: "domain",
    targetId: id,
    action,
    outcome: "success",
    data,
  });
}
export async function listDomains(
  db: Database,
  organizationId: string,
  query: queries.DomainQuery,
) {
  requireRow(await findOrganization(db, organizationId));
  return cursorPage(
    await queries.listOrganizationDomains(db, organizationId, query),
    query.limit,
  );
}
export function createDomain(
  db: Database,
  actor: Actor,
  organizationId: string,
  input: { domain: string },
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const row = await queries.createOrganizationDomain(tx, {
      organizationId,
      ...input,
    });
    await audit(tx, actor, organizationId, row.id, "domain.created", {
      domain: row.domain,
    });
    return row;
  });
}
function setStatus(
  db: Database,
  actor: Actor,
  organizationId: string,
  domainId: string,
  status: "active" | "disabled",
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const existing = requireRow(
      await queries.findOrganizationDomain(tx, organizationId, domainId),
    );
    if (existing.status === status)
      throw new ProblemError(
        409,
        `domain_already_${status}`,
        `Domain is already ${status}`,
      );
    const row = await queries.setOrganizationDomainStatus(
      tx,
      organizationId,
      domainId,
      status,
    );
    await audit(
      tx,
      actor,
      organizationId,
      domainId,
      status === "active" ? "domain.enabled" : "domain.disabled",
      { status },
    );
    return row!;
  });
}
export function disableDomain(
  db: Database,
  actor: Actor,
  organizationId: string,
  domainId: string,
) {
  return setStatus(db, actor, organizationId, domainId, "disabled");
}
export function enableDomain(
  db: Database,
  actor: Actor,
  organizationId: string,
  domainId: string,
) {
  return setStatus(db, actor, organizationId, domainId, "active");
}
