import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import { isDeepStrictEqual } from "node:util";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/sso-providers.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { revokeOrganizationGrantContexts } from "../db/queries/grant-contexts.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

export type SsoProviderInput = Pick<
  queries.CreateSsoProviderInput,
  "issuer" | "domain" | "oidc"
>;
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "Organisation or SSO provider not found",
    );
  return row;
}
function configuration(
  row: NonNullable<
    Awaited<ReturnType<typeof queries.findSsoProviderForCommand>>
  >,
) {
  const redacted = queries.redactSsoProvider(row);
  return {
    id: redacted.id,
    revision: redacted.revision,
    organizationId: redacted.organizationId,
    providerId: redacted.providerId,
    issuer: redacted.issuer,
    domain: redacted.domain,
    oidc: redacted.oidc,
  };
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
    targetType: "sso_provider",
    targetId: id,
    action,
    outcome: "success",
    data,
  });
}
export async function getSsoProvider(context: TenantReadContext<"directory">) {
  return requireRow(await queries.readSsoProvider(context));
}
export async function putSsoProvider(
  context: PlatformWriteContext,
  organizationId: string,
  input: SsoProviderInput,
  expected?: { id: string; revision: number } | null,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const organization = requireRow(
    await lockOrganizationForCommand(context, organizationId),
  );
  const existing = await queries.findSsoProviderForCommand(
    context,
    organizationId,
  );
  if (
    expected !== undefined &&
    (expected === null
      ? existing !== null
      : !existing ||
        existing.id !== expected.id ||
        existing.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "SSO configuration changed; read the current provider before issuing a new command",
    );
  const oidc = { ...input.oidc };
  const stored = JSON.parse(
    existing?.oidcConfig ?? "{}",
  ) as SsoProviderInput["oidc"];
  if (existing && oidc.clientSecret === undefined)
    oidc.clientSecret = stored.clientSecret;
  const changed =
    !existing ||
    existing.issuer !== input.issuer ||
    existing.domain !== input.domain.trim().toLowerCase() ||
    !isDeepStrictEqual(
      stored,
      JSON.parse(queries.serializeSsoProviderConfig({ ...input, oidc })),
    );
  const row = existing
    ? changed
      ? await queries.updateSsoProvider(context, existing.id, {
          ...input,
          oidc,
        })
      : existing
    : await queries.createSsoProvider(context, {
        ...input,
        oidc,
        organizationId,
        providerId: organization.slug,
      });
  const revokedGrantContexts = changed
    ? await revokeOrganizationGrantContexts(context, organizationId)
    : [];
  await audit(
    tx,
    actor,
    organizationId,
    row.id,
    !changed
      ? "sso_provider.update_unchanged"
      : existing
        ? "sso_provider.updated"
        : "sso_provider.created",
    {
      before: existing ? configuration(existing) : null,
      after: configuration(row),
      credentialsChanged: stored.clientSecret !== oidc.clientSecret,
      effects: { revokedGrantContexts },
    },
  );
  return {
    created: !existing,
    changed,
    provider: queries.redactSsoProvider(row),
  };
}
export async function deleteSsoProvider(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  requireRow(await lockOrganizationForCommand(context, organizationId));
  const row = requireRow(
    await queries.deleteSsoProvider(context, organizationId),
  );
  const revokedGrantContexts = await revokeOrganizationGrantContexts(
    context,
    organizationId,
  );
  await audit(tx, actor, organizationId, row.id, "sso_provider.deleted", {
    before: configuration(row),
    after: null,
    effects: { revokedGrantContexts },
  });
  return row.id;
}
