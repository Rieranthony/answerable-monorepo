import type { PlatformReadContext } from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import { and, desc, eq, gte, lt, inArray, type SQL } from "drizzle-orm";
import { beforeCursor, cursorPage, optionalEq } from "./lists.ts";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { auditEvents, auditEventUsers } from "../schema/index.ts";
import type { AuditActorType, AuditOutcome } from "../schema/vocabulary.ts";

export type AuditEvent = typeof auditEvents.$inferSelect;

/** Every action ID writes. Each has one payload shape, described in docs/04's
 * "Audit actions" table; a test keeps the two lists equal. */
export const auditActions = [
  "admin.auth_failed",
  "admin.denied",
  "admin.root_request",
  "auth.signin.succeeded",
  "auth.signout",
  "bootstrap.applied",
  "capability.created",
  "capability.removed",
  "capability.updated",
  "client.created",
  "client.disabled",
  "client.enabled",
  "client.erased",
  "client.grants_erased",
  "client.grants_revoked",
  "client.resource_linked",
  "client.resource_unlinked",
  "client.secret_rotated",
  "client.updated",
  "domain.created",
  "domain.deleted",
  "domain.disabled",
  "domain.enabled",
  "entitlement.created",
  "entitlement.disabled",
  "entitlement.enabled",
  "entitlement.removed",
  "entitlement.updated",
  "group.created",
  "group.disabled",
  "group.enabled",
  "group.erased",
  "group.updated",
  "group_member.added",
  "group_member.removed",
  "group_member.updated",
  "identity.linked",
  "member.reinstated",
  "member.removed",
  "member.updated",
  "oauth.token.issued",
  "oauth.token.rejected",
  "oauth.user.authorized",
  "oauth.user.denied",
  "oauth.user.issued",
  "oauth.user.revoked",
  "organization.created",
  "organization.disabled",
  "organization.enabled",
  "organization.erased",
  "organization.updated",
  "resource.created",
  "resource.disabled",
  "resource.enabled",
  "resource.erased",
  "resource.updated",
  "session.revoked",
  "session.revoked_all",
  "sso_provider.created",
  "sso_provider.deleted",
  "sso_provider.updated",
  "user.disabled",
  "user.email_retired",
  "user.enabled",
  "user.erased",
] as const;
export type AuditAction = (typeof auditActions)[number];

export type AuditEventInput = {
  operationId?: string;
  actorType: AuditActorType;
  actorId: string;
  organizationId?: string | null;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  outcome: AuditOutcome;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown> | null;
};

/** Insert the event and return it as written; occurred_at takes the column's
 * now() default, the transaction's start. */
export async function recordAuditEvent(
  executor: Executor,
  event: AuditEventInput,
) {
  // RETURNING requires SELECT permission, which protocol and unscoped writers lack.
  const row: Omit<AuditEvent, "occurredAt"> = {
    id: createId(),
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    outcome: event.outcome,
    schemaVersion: 1,
    organizationId: event.organizationId ?? null,
    targetId: event.targetId ?? null,
    reason: event.reason ?? null,
    requestId: event.requestId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    data: event.data ?? null,
    operationId: event.operationId ?? null,
  };
  await executor.insert(auditEvents).values(row);
  return row;
}

export type AuditEventFilters = {
  operationId?: string;
  organizationId?: string;
  actorId?: string;
  action?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
};

export function listAuditEvents(
  context: PlatformReadContext,
  filters: AuditEventFilters,
  page: { cursor?: string; limit: number },
) {
  const { tx } = context;
  return queryAuditEvents(tx, filters, page);
}

export function listOrganizationAuditEvents(
  context: TenantReadContext<"history">,
  filters: Omit<AuditEventFilters, "organizationId">,
  page: { cursor?: string; limit: number },
) {
  const { tx, organizationId } = context;
  return queryAuditEvents(tx, { ...filters, organizationId }, page);
}

async function queryAuditEvents(
  executor: Executor,
  filters: AuditEventFilters,
  page: { cursor?: string; limit: number },
  where?: SQL,
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        where,
        optionalEq(auditEvents.operationId, filters.operationId),
        optionalEq(auditEvents.organizationId, filters.organizationId),
        optionalEq(auditEvents.actorId, filters.actorId),
        optionalEq(auditEvents.outcome, filters.outcome),
        optionalEq(auditEvents.action, filters.action),
        optionalEq(auditEvents.targetType, filters.targetType),
        optionalEq(auditEvents.targetId, filters.targetId),
        filters.from === undefined
          ? undefined
          : gte(auditEvents.occurredAt, filters.from),
        filters.to === undefined
          ? undefined
          : lt(auditEvents.occurredAt, filters.to),
        beforeCursor(auditEvents.id, page.cursor),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(page.limit + 1);
  return cursorPage(rows, page.limit);
}

export function listUserAuditEvents(
  context: PlatformReadContext,
  userId: string,
  filters: Pick<AuditEventFilters, "action" | "outcome" | "from" | "to">,
  page: { cursor?: string; limit: number },
) {
  const { tx } = context;
  return queryAuditEvents(
    tx,
    filters,
    page,
    inArray(
      auditEvents.id,
      tx
        .select({ id: auditEventUsers.eventId })
        .from(auditEventUsers)
        .where(eq(auditEventUsers.userId, userId)),
    ),
  );
}
