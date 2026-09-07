import { and, desc, eq, gte, lt, or, inArray, sql } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { auditEvents, members } from "../schema/index.ts";
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
  outcome?: AuditOutcome;
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
  executor: Executor,
  userId: string,
  filters: Pick<AuditEventFilters, "action" | "outcome" | "from" | "to">,
  page: { cursor?: string; limit: number },
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        or(
          eq(auditEvents.actorId, userId),
          and(
            eq(auditEvents.targetType, "user"),
            eq(auditEvents.targetId, userId),
          ),
          and(
            inArray(auditEvents.targetType, ["member", "group_member"]),
            inArray(
              auditEvents.targetId,
              executor
                .select({ id: sql<string>`${members.id}::text` })
                .from(members)
                .where(eq(members.userId, userId)),
            ),
          ),
          and(
            eq(auditEvents.targetType, "session"),
            sql`${auditEvents.data}->>'userId' = ${userId}`,
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
