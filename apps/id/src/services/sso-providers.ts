import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/sso-providers.ts";
import {
  findOrganization,
  lockOrganization,
} from "../db/queries/organizations.ts";
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
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  id: string,
  action: string,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetType: "sso_provider",
    targetId: id,
    action,
    outcome: "success",
    data: {},
  });
}
export async function getSsoProvider(db: Database, organizationId: string) {
  requireRow(await findOrganization(db, organizationId));
  return queries.redactSsoProvider(
    requireRow(await queries.findSsoProviderByOrganization(db, organizationId)),
  );
}
export function putSsoProvider(
  db: Database,
  actor: Actor,
  organizationId: string,
  input: SsoProviderInput,
) {
  return db.transaction(async (tx) => {
    const organization = requireRow(await lockOrganization(tx, organizationId));
    const existing = await queries.findSsoProviderByOrganization(
      tx,
      organizationId,
    );
    const oidc = { ...input.oidc };
    if (existing && oidc.clientSecret === undefined) {
      const stored = JSON.parse(
        existing.oidcConfig ?? "{}",
      ) as SsoProviderInput["oidc"];
      oidc.clientSecret = stored.clientSecret;
    }
    const row = existing
      ? await queries.updateSsoProvider(tx, existing.id, { ...input, oidc })
      : await queries.createSsoProvider(tx, {
          ...input,
          oidc,
          organizationId,
          providerId: organization.slug,
        });
    await audit(
      tx,
      actor,
      organizationId,
      row.id,
      existing ? "sso_provider.updated" : "sso_provider.created",
    );
    return { created: !existing, provider: queries.redactSsoProvider(row) };
  });
}
export function deleteSsoProvider(
  db: Database,
  actor: Actor,
  organizationId: string,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const row = requireRow(await queries.deleteSsoProvider(tx, organizationId));
    await audit(tx, actor, organizationId, row.id, "sso_provider.deleted");
  });
}
