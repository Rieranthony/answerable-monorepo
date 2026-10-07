import { type PlatformWriteContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/organization-domains.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordAuditEvent, type AuditAction } from "../db/queries/audit.ts";
import { found } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

const notFound = "Organisation or domain not found";
function auditDomain(
  row: NonNullable<
    Awaited<ReturnType<typeof queries.findOrganizationDomainForCommand>>
  >,
) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    organizationId: row.organizationId,
    domain: row.domain,
    status: row.status,
  };
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  id: string,
  action: AuditAction,
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
  context: TenantReadContext<"directory">,
  query: queries.DomainQuery,
) {
  return queries.listOrganizationDomains(context, query);
}
export async function createDomain(
  context: PlatformWriteContext,
  organizationId: string,
  input: { domain: string },
) {
  const { tx, actor } = context;
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  const row = await queries.createOrganizationDomain(context, {
    organizationId,
    ...input,
  });
  await audit(tx, actor, organizationId, row.id, "domain.created", {
    domain: row.domain,
    before: null,
    after: auditDomain(row),
  });
  return row;
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  status: "active" | "disabled",
) {
  const { tx, actor } = context;
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  const existing = found(
    await queries.findOrganizationDomainForCommand(
      context,
      organizationId,
      domainId,
    ),
    notFound,
  );
  const changed = existing.status !== status;
  const row = changed
    ? await queries.setOrganizationDomainStatus(
        context,
        organizationId,
        domainId,
        status,
      )
    : existing;
  await audit(
    tx,
    actor,
    organizationId,
    domainId,
    changed
      ? status === "active"
        ? "domain.enabled"
        : "domain.disabled"
      : status === "active"
        ? "domain.enable_unchanged"
        : "domain.disable_unchanged",
    { status, before: auditDomain(existing), after: auditDomain(row!) },
  );
  return { domain: row!, changed };
}
export async function disableDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  return setStatus(context, organizationId, domainId, "disabled");
}
export async function enableDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  return setStatus(context, organizationId, domainId, "active");
}

export async function deleteOrganizationDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx, actor } = context;
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  const before = found(
    await queries.findOrganizationDomainForCommand(
      context,
      organizationId,
      domainId,
    ),
    notFound,
  );
  const row = await queries.deleteOrganizationDomain(
    context,
    organizationId,
    domainId,
  );
  await audit(tx, actor, organizationId, domainId, "domain.deleted", {
    before: auditDomain(before),
    after: auditDomain(row!),
    deletionMode: "soft",
  });
}
