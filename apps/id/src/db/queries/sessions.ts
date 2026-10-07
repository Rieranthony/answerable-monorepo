import type {
  PlatformReadContext,
  PlatformUsersContext,
} from "../../services/platform-context.ts";
import { and, desc, eq } from "drizzle-orm";
import { sessions } from "../schema/index.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage } from "./lists.ts";

export async function deleteUserSessionIds(
  context: PlatformUsersContext,
  userId: string,
): Promise<string[]> {
  const { tx: executor } = context;
  const rows = await executor
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return rows.map((row) => row.id).sort();
}

const selection = {
  id: sessions.id,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
  expiresAt: sessions.expiresAt,
  ipAddress: sessions.ipAddress,
  userAgent: sessions.userAgent,
  authenticationOrganizationId: sessions.authenticationOrganizationId,
};

export async function listUserSessions(
  context: PlatformReadContext,
  userId: string,
  page: PageQuery,
) {
  const { tx: executor } = context;
  return cursorPage(
    await executor
      .select(selection)
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          beforeCursor(sessions.id, page.cursor),
        ),
      )
      .orderBy(desc(sessions.id))
      .limit(page.limit + 1),
    page.limit,
  );
}

export async function deleteSession(
  context: PlatformUsersContext,
  userId: string,
  sessionId: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .returning(selection);
  return row ?? null;
}

export async function findUserSession(
  context: PlatformUsersContext,
  userId: string,
  sessionId: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .select(selection)
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .for("update");
  return row ?? null;
}
