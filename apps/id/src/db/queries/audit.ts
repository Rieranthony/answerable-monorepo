import { and, desc, eq, gte, lt } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { auditEvents } from "../schema/index.ts";
import type { AuditActorType, AuditOutcome } from "../schema/vocabulary.ts";

export type AuditEvent = typeof auditEvents.$inferSelect;

export type AuditEventInput = {
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
  const [row] = await executor
    .insert(auditEvents)
    .values({ ...event, id: createId() })
    .returning();
  return row!;
}

export type AuditEventFilters = {
  organizationId?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
};

export async function listAuditEvents(
  executor: Executor,
  filters: AuditEventFilters,
  page: { cursor?: string; limit: number },
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        filters.organizationId !== undefined
          ? eq(auditEvents.organizationId, filters.organizationId)
          : undefined,
        filters.actorId !== undefined
          ? eq(auditEvents.actorId, filters.actorId)
          : undefined,
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
