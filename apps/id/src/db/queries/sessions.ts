import type {
  PlatformReadContext,
  PlatformUsersContext,
} from "../../services/platform-context.ts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { sessions, ssoProviders } from "../schema/index.ts";
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

/**
 * How a browser's session came about, for the pages: `live` is false for a magic-link session
 * whose row is off, changed or gone, which holds no authority anywhere and reads as signed out.
 * A session with no origin, which holds none either, reads as a directory's.
 */
export async function readSessionOrigin(db: Executor, sessionId: string) {
  const [row] = await db
    .select({
      kind: ssoProviders.kind,
      live: sql<boolean>`${ssoProviders.enabled} and ${ssoProviders.deletedAt} is null and ${ssoProviders.revision} = ${sessions.authenticationProviderRevision}`,
    })
    .from(sessions)
    .innerJoin(
      ssoProviders,
      eq(ssoProviders.id, sessions.authenticationProviderId),
    )
    .where(eq(sessions.id, sessionId));
  return row ?? null;
}
