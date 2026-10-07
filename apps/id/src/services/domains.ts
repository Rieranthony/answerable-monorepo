import { type PlatformWriteContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/organization-domains.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordCommandEvent, statusAction } from "./audit.ts";
import { found } from "../http/problem.ts";

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
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  const row = await queries.createOrganizationDomain(context, {
    organizationId,
    ...input,
  });
  await recordCommandEvent(context, {
    organizationId,
    targetType: "domain",
    targetId: row.id,
    action: "domain.created",
    data: {
      domain: row.domain,
      before: null,
      after: auditDomain(row),
    },
  });
  return row;
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  status: "active" | "disabled",
) {
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
  await recordCommandEvent(context, {
    organizationId,
    targetType: "domain",
    targetId: domainId,
    action: statusAction("domain", status, changed),
    data: { status, before: auditDomain(existing), after: auditDomain(row!) },
  });
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
  await recordCommandEvent(context, {
    organizationId,
    targetType: "domain",
    targetId: domainId,
    action: "domain.deleted",
    data: {
      before: auditDomain(before),
      after: auditDomain(row!),
      deletionMode: "soft",
    },
  });
}
