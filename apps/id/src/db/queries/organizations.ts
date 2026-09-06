import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { organizations, members, oauthClients } from "../schema/index.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { createId } from "../../lib/id.ts";

export type OrganizationInput = {
  slug: string;
  name: string;
  logo?: string;
  metadata?: string;
};
export type OrganizationPatch = {
  name?: string;
  logo?: string | null;
  metadata?: string | null;
};
export type OrganizationQuery = PageQuery & {
  q?: string;
  status?: LifecycleStatus;
};

export function listOrganizations(
  executor: Executor,
  query: OrganizationQuery,
) {
  return executor
    .select()
    .from(organizations)
    .where(
      and(
        query.q === undefined
          ? undefined
          : or(
              ilike(organizations.name, `%${query.q}%`),
              ilike(organizations.slug, `%${query.q}%`),
            ),
        query.status === undefined
          ? undefined
          : eq(organizations.status, query.status),
        beforeCursor(organizations.id, query.cursor),
      ),
    )
    .orderBy(desc(organizations.id))
    .limit(query.limit + 1);
}

export async function findOrganization(executor: Executor, id: string) {
  const [row] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  return row ?? null;
}

/** Serialise lifecycle writes and prevent erasure while a write is in progress. */
export async function lockOrganization(executor: Executor, id: string) {
  const [row] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .for("update");
  return row ?? null;
}

export async function createOrganization(
  executor: Executor,
  input: OrganizationInput,
) {
  const [row] = await executor
    .insert(organizations)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}

export async function updateOrganization(
  executor: Executor,
  id: string,
  patch: OrganizationPatch,
) {
  const [row] = await executor
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, id))
    .returning();
  return row ?? null;
}

export async function setOrganizationStatus(
  executor: Executor,
  id: string,
  status: LifecycleStatus,
) {
  const [row] = await executor
    .update(organizations)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(eq(organizations.id, id))
    .returning();
  return row ?? null;
}

export async function deleteOrganization(executor: Executor, id: string) {
  await executor.delete(organizations).where(eq(organizations.id, id));
}

export async function listOrganizationMemberUserIds(
  executor: Executor,
  id: string,
) {
  const rows = await executor
    .select({ id: members.userId })
    .from(members)
    .where(eq(members.organizationId, id));
  return rows.map((row) => row.id);
}

export async function listOrganizationClientIds(
  executor: Executor,
  id: string,
) {
  const rows = await executor
    .select({ id: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.organizationId, id));
  return rows.map((row) => row.id);
}

export async function countOrganizationClients(executor: Executor, id: string) {
  const [row] = await executor
    .select({ count: count() })
    .from(oauthClients)
    .where(eq(oauthClients.organizationId, id));
  return row!.count;
}
