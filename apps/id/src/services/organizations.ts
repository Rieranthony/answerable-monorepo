import { revokeOrganizationGrantContexts } from "../db/queries/grant-contexts.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/organizations.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { revokeOrganizationMachineTokens } from "../db/queries/oauth-tokens.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireOrganization<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "Organisation not found");
  return row;
}

function configuration(
  row: NonNullable<Awaited<ReturnType<typeof queries.readOrganization>>>,
) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    revision: row.revision,
    slug: row.slug,
    name: row.name,
    logo: row.logo,
    status: row.status,
    authorizationVersion: row.authorizationVersion,
    disabledAt: row.disabledAt,
  };
}

function audit(
  executor: Executor,
  actor: Actor,
  id: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(executor, {
    ...actor,
    organizationId: id,
    action,
    targetType: "organization",
    targetId: id,
    outcome: "success",
    schemaVersion: action === "organization.erased" ? 3 : 1,
    data,
  });
}

export async function listOrganizations(
  context: PlatformReadContext,
  query: queries.OrganizationQuery,
) {
  return cursorPage(
    await queries.listOrganizations(context, query),
    query.limit,
  );
}

export async function getOrganization(context: TenantReadContext<"directory">) {
  return requireOrganization(await queries.readOrganization(context));
}

export async function createOrganization(
  context: PlatformWriteContext,
  input: queries.OrganizationInput,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const row = await queries.createOrganization(context, input);
  await audit(tx, actor, row.id, "organization.created", {
    before: null,
    after: configuration(row),
  });
  return row;
}

export async function updateOrganization(
  context: PlatformWriteContext,
  id: string,
  patch: queries.OrganizationPatch,
  expected?: { id: string; revision: number },
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const before = requireOrganization(
    await queries.lockOrganizationForCommand(context, id),
  );
  if (
    expected &&
    (before.id !== expected.id || before.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Organisation changed; read its current revision before issuing a new command",
    );
  const changed = Object.entries(patch).some(
    ([key, value]) => before[key as keyof queries.OrganizationPatch] !== value,
  );
  const row = changed
    ? (await queries.updateOrganization(context, id, patch))!
    : before;
  await audit(
    tx,
    actor,
    id,
    changed ? "organization.updated" : "organization.update_unchanged",
    {
      before: configuration(before),
      after: configuration(row),
      metadataChanged: before.metadata !== row.metadata,
    },
  );
  return { organization: row, changed };
}

export async function disableOrganization(
  context: PlatformWriteContext,
  id: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireOrganization(
    await queries.lockOrganizationForCommand(context, id),
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
  const revokedMachineAccessTokenIds = changed
    ? await revokeOrganizationMachineTokens(context, id)
    : [];
  await audit(
    tx,
    actor,
    id,
    changed ? "organization.disabled" : "organization.disable_unchanged",
    {
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
  );
  return { organization: row, changed };
}

export async function enableOrganization(
  context: PlatformWriteContext,
  id: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = requireOrganization(
    await queries.lockOrganizationForCommand(context, id),
  );
  const changed = existing.status !== "active";
  const row = changed
    ? (await queries.setOrganizationStatus(context, id, "active"))!
    : existing;
  await audit(
    tx,
    actor,
    id,
    changed ? "organization.enabled" : "organization.enable_unchanged",
    {
      before: configuration(existing),
      after: configuration(row),
    },
  );
  return { organization: row, changed };
}

export async function eraseOrganization(
  context: PlatformWriteContext,
  id: string,
  confirm: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const before = requireOrganization(
    await queries.lockOrganizationForCommand(context, id),
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
  await audit(tx, actor, id, "organization.erased", {
    before: configuration(before),
    after: configuration(row),
    deletionMode: "soft",
    revokedGrantContexts: revokedGrantContexts.map((row) => ({
      ...row,
      organizationId: id,
    })),
    effects,
  });
}
