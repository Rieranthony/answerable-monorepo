import { revokeOrganizationGrantContexts } from "../db/queries/grant-contexts.ts";
import { type PlatformWriteContext } from "./platform-context.ts";
import * as queries from "../db/queries/organizations.ts";
import { recordCommandEvent, evidence } from "./audit.ts";
import { revokeOrganizationMachineTokens } from "../db/queries/oauth-tokens.ts";
import { found, ProblemError } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";
import { activeOrganizationDomains } from "../db/queries/organization-domains.ts";
import type { MagicLinkAdmissionMode } from "../db/schema/vocabulary.ts";

const notFound = "Organisation not found";

export async function createOrganization(
  context: PlatformWriteContext,
  input: queries.OrganizationInput,
) {
  const row = await queries.createOrganization(context, input);
  await recordCommandEvent(context, {
    organizationId: row.id,
    targetType: "organization",
    targetId: row.id,
    action: "organization.created",
    data: {
      before: null,
      after: evidence(row),
    },
  });
  return queries.answerOrganization(context, row.id);
}

export async function updateOrganization(
  context: PlatformWriteContext,
  id: string,
  patch: queries.OrganizationPatch,
  expected?: { id: string; revision: number },
) {
  const before = found(
    await queries.lockOrganizationForCommand(context, id),
    notFound,
  );
  assertRevision(
    before,
    expected,
    "Organisation changed; read its current revision before issuing a new command",
  );
  const changed = Object.entries(patch).some(
    ([key, value]) => before[key as keyof queries.OrganizationPatch] !== value,
  );
  const row = changed
    ? (await queries.updateOrganization(context, id, patch))!
    : before;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed)
    await recordCommandEvent(context, {
      organizationId: id,
      targetType: "organization",
      targetId: id,
      action: "organization.updated",
      data: { before: evidence(before), after: evidence(row) },
    });
  return { row: await queries.answerOrganization(context, id), changed };
}

export async function disableOrganization(
  context: PlatformWriteContext,
  id: string,
) {
  const existing = found(
    await queries.lockOrganizationForCommand(context, id),
    notFound,
  );
  const stateChanged = existing.status !== "disabled";
  const row = stateChanged
    ? (await queries.setOrganizationStatus(context, id, "disabled"))!
    : existing;
  const revokedGrantContexts = await revokeOrganizationGrantContexts(
    context,
    id,
  );
  const changed = stateChanged || revokedGrantContexts.length > 0;
  if (!changed)
    return { row: await queries.answerOrganization(context, id), changed };
  const revokedMachineAccessTokenIds = await revokeOrganizationMachineTokens(
    context,
    id,
  );
  await recordCommandEvent(context, {
    organizationId: id,
    targetType: "organization",
    targetId: id,
    action: "organization.disabled",
    data: {
      before: {
        status: existing.status,
        authorizationVersion: existing.authorizationVersion,
      },
      after: {
        status: row.status,
        authorizationVersion: row.authorizationVersion,
      },
      effects: { revokedMachineAccessTokenIds, revokedGrantContexts },
    },
  });
  return { row: await queries.answerOrganization(context, id), changed };
}

export async function enableOrganization(
  context: PlatformWriteContext,
  id: string,
) {
  const existing = found(
    await queries.lockOrganizationForCommand(context, id),
    notFound,
  );
  const changed = existing.status !== "active";
  const row = changed
    ? (await queries.setOrganizationStatus(context, id, "active"))!
    : existing;
  if (changed)
    await recordCommandEvent(context, {
      organizationId: id,
      targetType: "organization",
      targetId: id,
      action: "organization.enabled",
      data: {
        before: evidence(existing),
        after: evidence(row),
      },
    });
  return { row: await queries.answerOrganization(context, id), changed };
}

/** Sessions and grants name this row and its revision, so turning it off ends those at
 * once and touches nothing else. A new revision never matches an old one, so turning it
 * back on revives neither. */
async function setMagicLink(
  context: PlatformWriteContext,
  id: string,
  enabled: boolean,
) {
  found(await queries.lockOrganizationForCommand(context, id), notFound);
  const before = await queries.lockMagicLinkForCommand(context, id);
  if (enabled && (await queries.isPlatformOrganization(context, id)))
    throw new ProblemError(
      409,
      "platform_magic_link",
      "The platform organisation cannot use magic links",
    );
  const changed = before.enabled !== enabled;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed) {
    const after = await queries.setMagicLinkEnabled(
      context,
      before.id,
      enabled,
    );
    await recordCommandEvent(context, {
      organizationId: id,
      targetType: "organization",
      targetId: id,
      action: enabled
        ? "organization.magic_link_enabled"
        : "organization.magic_link_disabled",
      data: {
        before: { enabled: before.enabled, revision: before.revision },
        after: { enabled: after.enabled, revision: after.revision },
      },
    });
  }
  return { row: await queries.answerOrganization(context, id), changed };
}

export function enableMagicLink(context: PlatformWriteContext, id: string) {
  return setMagicLink(context, id, true);
}

export function disableMagicLink(context: PlatformWriteContext, id: string) {
  return setMagicLink(context, id, false);
}

/**
 * Opening a firm to anyone at its domains needs every active domain proved, and at least one.
 * Admission still checks each address's own domain, so a domain added afterwards admits nobody
 * new until it is proved. Nobody can publish that record at a public mail domain.
 */
async function refuseUnprovedDomains(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const domains = await activeOrganizationDomains(context.tx, organizationId);
  const unverified = domains
    .filter(({ verifiedAt }) => verifiedAt === null)
    .map(({ domain }) => domain);
  if (!domains.length || unverified.length)
    throw new ProblemError(
      409,
      "domain_not_verified",
      "Every active domain must be proved before anyone at them may ask for a link",
      domains.length
        ? "Verify each domain named here, or remove it, then ask again."
        : "The organisation has no active domain. Add one and verify it, then ask again.",
      { details: { unverified } },
    );
}

/** Who may ask for a link. Sessions and grants name the row's revision, which this does not
 * move: narrowing it leaves members as members, so it ends nothing. */
export async function setMagicLinkAdmission(
  context: PlatformWriteContext,
  id: string,
  admission: MagicLinkAdmissionMode,
) {
  found(await queries.lockOrganizationForCommand(context, id), notFound);
  const before = await queries.lockMagicLinkForCommand(context, id);
  const changed = before.admission !== admission;
  if (changed && admission === "domain") {
    if (await queries.isPlatformOrganization(context, id))
      throw new ProblemError(
        409,
        "platform_magic_link",
        "The platform organisation cannot use magic links",
      );
    await refuseUnprovedDomains(context, id);
  }
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed) {
    const after = await queries.setMagicLinkAdmission(
      context,
      before.id,
      admission,
    );
    await recordCommandEvent(context, {
      organizationId: id,
      targetType: "organization",
      targetId: id,
      action: "organization.magic_link_admission_changed",
      data: {
        before: { admission: before.admission, revision: before.revision },
        after: { admission: after.admission, revision: after.revision },
      },
    });
  }
  return { row: await queries.answerOrganization(context, id), changed };
}

export async function eraseOrganization(
  context: PlatformWriteContext,
  id: string,
  confirm: string,
) {
  const before = found(
    await queries.lockOrganizationForCommand(context, id),
    notFound,
  );
  if (confirm !== id)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the organisation ID",
    );
  if (await queries.countOrganizationClients(context, id))
    throw new ProblemError(
      409,
      "organization_has_clients",
      "Remove the organisation's clients before erasure",
    );
  const revokedGrantContexts = await revokeOrganizationGrantContexts(
    context,
    id,
  );
  const { row, effects } = await queries.deleteOrganization(context, id);
  await recordCommandEvent(context, {
    organizationId: id,
    targetType: "organization",
    targetId: id,
    action: "organization.erased",
    data: {
      before: evidence(before),
      after: evidence(row),
      deletionMode: "soft",
      revokedGrantContexts: revokedGrantContexts.map((row) => ({
        ...row,
        organizationId: id,
      })),
      effects,
    },
  });
}
