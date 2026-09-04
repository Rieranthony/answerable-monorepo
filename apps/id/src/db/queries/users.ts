import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { users } from "../schema/index.ts";

export class UserNotRetirableError extends Error {
  constructor(userId: string) {
    super(`User cannot be retired: ${userId}`);
    this.name = "UserNotRetirableError";
  }
}

export function retiredEmailFor(userId: string): string {
  return `${userId}@retired.invalid`;
}

export async function retireUserEmail(db: Database, userId: string) {
  const [user] = await db
    .update(users)
    .set({
      retiredEmail: users.email,
      email: sql`${users.id}::text || '@retired.invalid'`,
    })
    .where(
      and(
        eq(users.id, userId),
        eq(users.status, "disabled"),
        isNull(users.retiredEmail),
      ),
    )
    .returning();

  if (!user) throw new UserNotRetirableError(userId);

  return user;
}
