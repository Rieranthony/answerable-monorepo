import { type PlatformWriteContext } from "./platform-context.ts";
import * as queries from "../db/queries/organization-domains.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordCommandEvent, statusAction, evidence } from "./audit.ts";
import { found } from "../http/problem.ts";

const notFound = "Organisation or domain not found";
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
      after: evidence(row),
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
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed)
    await recordCommandEvent(context, {
      organizationId,
      targetType: "domain",
      targetId: domainId,
      action: statusAction("domain", status),
      data: { status, before: evidence(existing), after: evidence(row!) },
    });
  return { row: row!, changed };
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
      before: evidence(before),
      after: evidence(row!),
      deletionMode: "soft",
    },
  });
}
