import { identityScopes } from "../auth/grant-scopes.ts";
import { adminScopes } from "../http/admin/scopes.ts";
import { sql, and, desc, eq } from "drizzle-orm";
import {
  organizationCapabilities,
  systemBindings,
} from "../db/schema/index.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { readClientForPolicy } from "../db/queries/oauth-clients.ts";
import { readResourceForPolicy } from "../db/queries/oauth-resources.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { createId } from "../lib/id.ts";
import {
  beforeCursor,
  cursorPage,
  type PageQuery,
} from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "./tenant-context.ts";

type Row = typeof organizationCapabilities.$inferSelect;
export type CapabilityInput = (
  | {
      clientId: string;
      resource: string;
      grantKind: "client_credentials";
    }
  | {
      clientId: string;
      resource: string | null;
      grantKind: "authorization_code" | "refresh_token";
    }
  | { clientId: null; resource: string; grantKind: "admin_session" }
) & {
  scopes: string[];
  validFrom?: Date | null;
  validUntil?: Date | null;
};
export type CapabilityPatch = Partial<
  Pick<Row, "scopes" | "status" | "validFrom" | "validUntil">
>;
const where = (organizationId: string, id: string) =>
  and(
    sql`${organizationCapabilities.deletedAt} is null`,
    eq(organizationCapabilities.organizationId, organizationId),
    eq(organizationCapabilities.id, id),
  );
function required<T>(row: T | null | undefined): T {
  if (!row) throw new ProblemError(404, "not_found", "Not found");
  return row;
}

export async function listCapabilities(
  context: TenantReadContext<"directory">,
  query: PageQuery,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  return cursorPage(
    await tx
      .select()
      .from(organizationCapabilities)
      .where(
        and(
          sql`${organizationCapabilities.deletedAt} is null`,
          eq(organizationCapabilities.organizationId, organizationId),
          beforeCursor(organizationCapabilities.id, query.cursor),
        ),
      )
      .orderBy(desc(organizationCapabilities.id))
      .limit(query.limit + 1),
    query.limit,
  );
}
export async function getCapability(
  context: TenantReadContext<"directory">,
  id: string,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  return required(
    (
      await tx
        .select()
        .from(organizationCapabilities)
        .where(where(organizationId, id))
    )[0],
  );
}

async function validateTarget(
  context: PlatformWriteContext,
  organizationId: string,
  input: Pick<Row, "clientId" | "resource" | "grantKind" | "scopes">,
) {
  const { tx } = requirePlatformWriteContext(context);
  const client =
    input.clientId !== null
      ? required(await readClientForPolicy(context, input.clientId))
      : null;
  const resource =
    input.resource === null
      ? null
      : required(await readResourceForPolicy(context, input.resource));
  if (
    (input.grantKind === "client_credentials" &&
      client!.organizationId !== organizationId) ||
    (resource?.classification === "tenant_owned" &&
      resource.organizationId !== organizationId)
  )
    throw new ProblemError(
      400,
      "validation_failed",
      "Capability target belongs to another organisation",
    );
  if (input.grantKind === "admin_session") {
    const [binding] = await tx
      .select()
      .from(systemBindings)
      .where(eq(systemBindings.resourceId, resource!.id));
    if (
      !binding ||
      (organizationId !== binding.organizationId &&
        input.scopes.some((scope) => scope.startsWith("platform:")))
    )
      throw new ProblemError(
        400,
        "validation_failed",
        "Direct administration requires the bound resource and permitted tenant scopes",
      );
  }
  const userGrant =
    input.grantKind === "authorization_code" ||
    input.grantKind === "refresh_token";
  if (
    userGrant &&
    (!client!.grantTypes?.includes("authorization_code") ||
      !client!.grantTypes.includes(input.grantKind))
  )
    throw new ProblemError(
      400,
      "validation_failed",
      "Client registration does not support this user grant kind",
    );
  const clientScopes: readonly string[] =
    input.grantKind === "admin_session"
      ? adminScopes
      : input.grantKind === "client_credentials"
        ? (client!.clientCredentialsScopes ?? [])
        : (client!.scopes ?? []);
  if (
    input.scopes.some(
      (scope) =>
        !clientScopes.includes(scope) ||
        (resource !== null &&
          !(resource.allowedScopes ?? []).includes(scope)) ||
        (userGrant && identityScopes.has(scope) !== (resource === null)),
    )
  )
    throw new ProblemError(
      400,
      "validation_failed",
      "Capability scopes exceed the client/resource ceiling or mix login and resource scopes",
    );
}
function audit(
  context: PlatformWriteContext,
  row: Row,
  before: Row | null,
  changed: boolean,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  return recordAuditEvent(tx, {
    ...actor,
    organizationId: row.organizationId,
    targetType: "capability",
    targetId: row.id,
    action:
      before === null
        ? "capability.created"
        : changed
          ? "capability.updated"
          : "capability.update_unchanged",
    outcome: "success",
    data: { before, after: row },
  });
}
export async function createCapability(
  context: PlatformWriteContext,
  organizationId: string,
  input: CapabilityInput,
) {
  const { tx } = requirePlatformWriteContext(context);
  required(await lockOrganizationForCommand(context, organizationId));
  await validateTarget(context, organizationId, input);
  const [row] = await tx
    .insert(organizationCapabilities)
    .values({
      ...input,
      scopes: [...new Set(input.scopes)].sort(),
      organizationId,
      id: createId(),
    })
    .returning();
  await audit(context, row!, null, true);
  return row!;
}
export async function updateCapability(
  context: PlatformWriteContext,
  organizationId: string,
  id: string,
  patch: CapabilityPatch,
  expected?: { id: string; revision: number },
) {
  const { tx } = requirePlatformWriteContext(context);
  required(await lockOrganizationForCommand(context, organizationId));
  const before = required(
    (
      await tx
        .select()
        .from(organizationCapabilities)
        .where(where(organizationId, id))
    )[0],
  );
  if (
    expected &&
    (before.id !== expected.id || before.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Capability changed; read its current revision",
    );
  const normalized = {
    ...patch,
    ...(patch.scopes === undefined
      ? {}
      : { scopes: [...new Set(patch.scopes)].sort() }),
  };
  // Disabling an existing ceiling must remain possible after a registration narrows its scopes.
  if (normalized.scopes !== undefined)
    await validateTarget(context, organizationId, {
      clientId: before.clientId,
      grantKind: before.grantKind,
      resource: before.resource,
      scopes: normalized.scopes,
    });
  const changed = Object.entries(normalized).some(
    ([key, value]) =>
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(before[key as keyof Row]),
  );
  const row = changed
    ? (
        await tx
          .update(organizationCapabilities)
          .set(normalized)
          .where(where(organizationId, id))
          .returning()
      )[0]!
    : before;
  await audit(context, row, before, changed);
  return { row, changed };
}

export async function removeCapability(
  context: PlatformWriteContext,
  organizationId: string,
  id: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  required(await lockOrganizationForCommand(context, organizationId));
  const before = required(
    (
      await tx
        .select()
        .from(organizationCapabilities)
        .where(where(organizationId, id))
    )[0],
  );
  const [after] = await tx
    .update(organizationCapabilities)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${organizationCapabilities.deletedAt} is null`,
        where(organizationId, id),
      ),
    )
    .returning();
  await recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetType: "capability",
    targetId: id,
    action: "capability.removed",
    outcome: "success",
    schemaVersion: 2,
    data: { before, after, deletionMode: "soft" },
  });
}

/** Erasure must not silently discard platform approvals. */
export async function requireNoCapabilityReferences(
  context: PlatformWriteContext,
  target: { clientId: string } | { resource: string },
) {
  const { tx } = requirePlatformWriteContext(context);
  const rows = await tx
    .select({ id: organizationCapabilities.id })
    .from(organizationCapabilities)
    .where(
      and(
        sql`${organizationCapabilities.deletedAt} is null`,
        "clientId" in target
          ? eq(organizationCapabilities.clientId, target.clientId)
          : eq(organizationCapabilities.resource, target.resource),
      ),
    )
    .limit(1);
  if (rows.length)
    throw new ProblemError(
      409,
      "capability_references_exist",
      "Remove the target's capability ceilings before erasure",
    );
}
