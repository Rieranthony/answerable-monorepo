import { type PlatformWriteContext } from "./platform-context.ts";
import * as queries from "../db/queries/organization-domains.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { endMagicLinkUseOfDomain } from "../db/queries/magic-link-requests.ts";
import { recordCommandEvent, statusAction, evidence } from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
import {
  domainVerificationRecord,
  txtRecordsHold,
} from "./domain-verification.ts";

const notFound = "Organisation or domain not found";

/** A domain as an answer shows it: the record to publish, and not the token alone. */
export function shownDomain<
  Row extends { domain: string; verificationToken: string },
>({ verificationToken, ...row }: Row) {
  return {
    ...row,
    verificationRecord: domainVerificationRecord({
      domain: row.domain,
      verificationToken,
    }),
  };
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
      after: evidence(row),
    },
  });
  return shownDomain(row);
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
  if (changed) {
    const magicLinkEffects =
      status === "disabled"
        ? await endMagicLinkUseOfDomain(
            context,
            organizationId,
            existing.domain,
          )
        : null;
    await recordCommandEvent(context, {
      organizationId,
      targetType: "domain",
      targetId: domainId,
      action: statusAction("domain", status),
      data: {
        status,
        before: evidence(existing),
        after: evidence(row!),
        ...(magicLinkEffects ? { magicLinkEffects } : {}),
      },
    });
  }
  return { row: shownDomain(row!), changed };
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
  const magicLinkEffects = await endMagicLinkUseOfDomain(
    context,
    organizationId,
    before.domain,
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
      magicLinkEffects,
    },
  });
}

/** The record was not there. `wasProved` says a proof is now stale, which the route clears
 * in a command of its own, since this refusal rolls back. */
export class DomainProofFailed extends ProblemError {
  constructor(
    record: ReturnType<typeof domainVerificationRecord>,
    readonly wasProved: boolean,
  ) {
    super(
      409,
      "domain_verification_failed",
      "The domain's DNS record was not found",
      `Publish a ${record.type} record at ${record.name} with the value ${record.value}, then ask again. A new record can take time to reach every resolver.`,
      { expected: record },
    );
  }
}

/** What DNS held has been read, outside this transaction; this compares it with the row. */
export async function proveDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  records: string[][],
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
  const record = domainVerificationRecord(existing);
  if (!txtRecordsHold(records, record.value))
    throw new DomainProofFailed(record, existing.verifiedAt !== null);
  const changed = existing.verifiedAt === null;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (!changed) return { row: shownDomain(existing), changed };
  const row = await queries.setOrganizationDomainProof(
    context,
    organizationId,
    domainId,
    true,
  );
  await recordCommandEvent(context, {
    organizationId,
    targetType: "domain",
    targetId: domainId,
    action: "domain.verified",
    data: {
      domain: row!.domain,
      before: evidence(existing),
      after: evidence(row!),
    },
  });
  return { row: shownDomain(row!), changed };
}

/** A re-check that failed takes the proof away, so that the domain fails closed. */
export async function endDomainProof(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
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
  const changed = existing.verifiedAt !== null;
  if (changed) {
    const row = await queries.setOrganizationDomainProof(
      context,
      organizationId,
      domainId,
      false,
    );
    await recordCommandEvent(context, {
      organizationId,
      targetType: "domain",
      targetId: domainId,
      action: "domain.verification_lost",
      data: {
        domain: row!.domain,
        before: evidence(existing),
        after: evidence(row!),
      },
    });
  }
  return { changed };
}
