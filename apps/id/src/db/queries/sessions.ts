import { inArray } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { sessions } from "../schema/index.ts";

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
