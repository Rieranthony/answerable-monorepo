import {
  and,
  count,
  desc,
  eq,
  exists,
  ilike,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import type { Executor } from "../client.ts";
import {
  users,
  members,
  organizations,
  accounts,
  sessions,
} from "../schema/index.ts";

export class UserNotRetirableError extends Error {
  constructor(userId: string) {
    super(`User cannot be retired: ${userId}`);
    this.name = "UserNotRetirableError";
  }
}

export function retiredEmailFor(userId: string): string {
  return `${userId}@retired.invalid`;
}

export async function retireUserEmail(db: Executor, userId: string) {
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

import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";

export type UserQuery = PageQuery & {
  q?: string;
  email?: string;
  status?: typeof users.$inferSelect.status;
  organizationId?: string;
};

export function listUsers(executor: Executor, query: UserQuery) {
  return executor
    .select()
    .from(users)
    .where(
      and(
        query.email === undefined
          ? undefined
          : eq(users.email, query.email.toLowerCase()),
        query.q === undefined
          ? undefined
          : or(
              ilike(users.email, `%${query.q}%`),
              ilike(users.name, `%${query.q}%`),
            ),
        query.status === undefined ? undefined : eq(users.status, query.status),
        query.organizationId === undefined
          ? undefined
          : exists(
              executor
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.userId, users.id),
                    eq(members.organizationId, query.organizationId),
                  ),
                ),
            ),
        beforeCursor(users.id, query.cursor),
      ),
    )
    .orderBy(desc(users.id))
    .limit(query.limit + 1);
}

export async function lockUser(executor: Executor, userId: string) {
  const [row] = await executor
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  return row ?? null;
}

export async function findUser(executor: Executor, userId: string) {
  const [row] = await executor.select().from(users).where(eq(users.id, userId));
  if (!row) return null;
  const memberships = await executor
    .select({
      memberId: members.id,
      organizationId: organizations.id,
      slug: organizations.slug,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
      effective: sql<boolean>`(${isEffective(members)})`,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(desc(members.id));
  const identities = await executor
    .select({
      issuer: accounts.issuer,
      providerId: accounts.providerId,
      directoryId: accounts.directoryId,
      directoryUserId: accounts.directoryUserId,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(desc(accounts.id));
  const [total] = await executor
    .select({ count: count() })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return {
    ...row,
    memberships,
    accounts: identities,
    sessionCount: total!.count,
  };
}

export async function setUserStatus(
  executor: Executor,
  userId: string,
  status: "active" | "disabled",
) {
  const [row] = await executor
    .update(users)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

export async function deleteUser(executor: Executor, userId: string) {
  const [row] = await executor
    .delete(users)
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

export async function findUserByEmail(executor: Executor, email: string) {
  const [row] = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return row ? findUser(executor, row.id) : null;
}
