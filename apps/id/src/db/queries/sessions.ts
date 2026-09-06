import { and, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { sessions, members } from "../schema/index.ts";

export async function deleteUserSessions(
  executor: Executor,
  userIds: string[],
): Promise<number> {
  if (!userIds.length) return 0;
  const rows = await executor
    .delete(sessions)
    .where(inArray(sessions.userId, userIds))
    .returning({ id: sessions.id });
  return rows.length;
}

import { beforeCursor, type PageQuery } from "../../http/pagination.ts";

const selection = {
  id: sessions.id,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
  expiresAt: sessions.expiresAt,
  ipAddress: sessions.ipAddress,
  userAgent: sessions.userAgent,
  activeOrganizationId: sessions.activeOrganizationId,
};

export function listUserSessions(
  executor: Executor,
  userId: string,
  page: PageQuery,
) {
  return executor
    .select(selection)
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), beforeCursor(sessions.id, page.cursor)),
    )
    .orderBy(desc(sessions.id))
    .limit(page.limit + 1);
}

export async function deleteSession(
  executor: Executor,
  userId: string,
  sessionId: string,
) {
  const [row] = await executor
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .returning(selection);
  return row ?? null;
}

export async function findMemberUserId(
  executor: Executor,
  organizationId: string,
  memberId: string,
) {
  const [row] = await executor
    .select({ userId: members.userId })
    .from(members)
    .where(
      and(eq(members.organizationId, organizationId), eq(members.id, memberId)),
    );
  return row?.userId ?? null;
}

export async function findUserSession(
  executor: Executor,
  userId: string,
  sessionId: string,
) {
  const [row] = await executor
    .select(selection)
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .for("update");
  return row ?? null;
}
