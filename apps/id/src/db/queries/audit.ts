import {
  requirePlatformReadContext,
  type PlatformReadContext,
} from "../../services/platform-context.ts";
import {
  requireTenantHistoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { auditEvents, auditEventSubjects } from "../schema/index.ts";
import type { AuditActorType, AuditOutcome } from "../schema/vocabulary.ts";

export type AuditEvent = typeof auditEvents.$inferSelect;

export type AuditEventInput = {
  schemaVersion?: 1 | 2 | 3 | 4;
  operationId?: string;
  actorType: AuditActorType;
  actorId: string;
  organizationId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome: AuditOutcome;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown> | null;
};

export async function recordAuditEvent(
  executor: Executor,
  event: AuditEventInput,
) {
  // RETURNING requires SELECT permission, which protocol and unscoped writers lack.
  const time = await executor.execute<{ occurredAt: string }>(
    sql`select current_timestamp as "occurredAt"`,
  );
  const row: AuditEvent = {
    id: createId(),
    occurredAt: new Date(time.rows[0]!.occurredAt),
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    outcome: event.outcome,
    schemaVersion: event.schemaVersion ?? 1,
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
  const { tx } = requirePlatformReadContext(context);
  return queryAuditEvents(tx, filters, page);
}

export function listOrganizationAuditEvents(
  context: TenantReadContext<"history">,
  filters: Omit<AuditEventFilters, "organizationId">,
  page: { cursor?: string; limit: number },
) {
  const { tx, organizationId } = requireTenantHistoryContext(context);
  return queryAuditEvents(
    tx,
    { ...filters, organizationId },
    page,
    // Legacy link payloads did not establish the target's visibility. Retain
    // them for platform auditors without consulting mutable/live target rows.
    or(
      inArray(auditEvents.schemaVersion, [2, 3]),
      notInArray(auditEvents.action, [
        "client.resource_linked",
        "client.resource_unlinked",
        "client.resource_unchanged",
      ]),
    ),
  );
}

async function queryAuditEvents(
  executor: Executor,
  filters: AuditEventFilters,
  page: { cursor?: string; limit: number },
  visibility?: SQL,
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        visibility,
        filters.operationId === undefined
          ? undefined
          : eq(auditEvents.operationId, filters.operationId),
        filters.organizationId !== undefined
          ? eq(auditEvents.organizationId, filters.organizationId)
          : undefined,
        filters.actorId !== undefined
          ? eq(auditEvents.actorId, filters.actorId)
          : undefined,
        filters.outcome === undefined
          ? undefined
          : eq(auditEvents.outcome, filters.outcome),
        filters.action !== undefined
          ? eq(auditEvents.action, filters.action)
          : undefined,
        filters.targetType !== undefined
          ? eq(auditEvents.targetType, filters.targetType)
          : undefined,
        filters.targetId !== undefined
          ? eq(auditEvents.targetId, filters.targetId)
          : undefined,
        filters.from !== undefined
          ? gte(auditEvents.occurredAt, filters.from)
          : undefined,
        filters.to !== undefined
          ? lt(auditEvents.occurredAt, filters.to)
          : undefined,
        page.cursor !== undefined ? lt(auditEvents.id, page.cursor) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  return {
    items,
    nextCursor: rows.length > page.limit ? items.at(-1)!.id : null,
  };
}

export async function listUserAuditEvents(
  context: PlatformReadContext,
  userId: string,
  filters: Pick<AuditEventFilters, "action" | "outcome" | "from" | "to">,
  page: { cursor?: string; limit: number },
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const { tx: executor } = requirePlatformReadContext(context);
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        inArray(
          auditEvents.id,
          executor
            .select({ id: auditEventSubjects.eventId })
            .from(auditEventSubjects)
            .where(
              and(
                eq(auditEventSubjects.entityType, "user"),
                eq(auditEventSubjects.entityId, userId),
              ),
            ),
        ),
        filters.outcome === undefined
          ? undefined
          : eq(auditEvents.outcome, filters.outcome),
        filters.action !== undefined
          ? eq(auditEvents.action, filters.action)
          : undefined,
        filters.from !== undefined
          ? gte(auditEvents.occurredAt, filters.from)
          : undefined,
        filters.to !== undefined
          ? lt(auditEvents.occurredAt, filters.to)
          : undefined,
        page.cursor !== undefined ? lt(auditEvents.id, page.cursor) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  return {
    items,
    nextCursor: rows.length > page.limit ? items.at(-1)!.id : null,
  };
}
