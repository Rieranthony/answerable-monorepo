import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  oauthResources,
  entitlements,
  oauthClientResources,
} from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { createId } from "../../lib/id.ts";

export type ResourceInput = {
  identifier: string;
  name: string;
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  allowedScopes: string[];
  signingAlgorithm?: "EdDSA" | "ES256" | "RS256";
};
export type ResourcePatch = Partial<
  Omit<ResourceInput, "identifier" | "signingAlgorithm">
>;
export type ResourceQuery = PageQuery & { q?: string; disabled?: boolean };
export function listResources(executor: Executor, query: ResourceQuery) {
  return executor
    .select()
    .from(oauthResources)
    .where(
      and(
        query.q === undefined
          ? undefined
          : or(
              ilike(oauthResources.name, `%${query.q}%`),
              ilike(oauthResources.identifier, `%${query.q}%`),
            ),
        query.disabled === undefined
          ? undefined
          : eq(oauthResources.disabled, query.disabled),
        beforeCursor(oauthResources.id, query.cursor),
      ),
    )
    .orderBy(desc(oauthResources.id))
    .limit(query.limit + 1);
}
export async function findResource(executor: Executor, identifier: string) {
  const [row] = await executor
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.identifier, identifier));
  return row ?? null;
}
/** Serialise policy and lifecycle writes against erasure. */
export async function lockResource(executor: Executor, identifier: string) {
  const [row] = await executor
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.identifier, identifier))
    .for("update");
  return row ?? null;
}
export async function createResource(executor: Executor, input: ResourceInput) {
  const [row] = await executor
    .insert(oauthResources)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}
export async function updateResource(
  executor: Executor,
  identifier: string,
  patch: ResourcePatch,
) {
  const [row] = await executor
    .update(oauthResources)
    .set(patch)
    .where(eq(oauthResources.identifier, identifier))
    .returning();
  return row ?? null;
}
export async function setResourceDisabled(
  executor: Executor,
  identifier: string,
  disabled: boolean,
) {
  const [row] = await executor
    .update(oauthResources)
    .set({ disabled })
    .where(eq(oauthResources.identifier, identifier))
    .returning();
  return row ?? null;
}
export async function deleteResource(executor: Executor, identifier: string) {
  await executor
    .delete(oauthResources)
    .where(eq(oauthResources.identifier, identifier));
}
export async function countResourceEntitlements(
  executor: Executor,
  identifier: string,
) {
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(eq(entitlements.resource, identifier));
  return row!.count;
}

export function listResourceClients(executor: Executor, resource: string) {
  return executor
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.resourceId, resource))
    .orderBy(desc(oauthClientResources.id));
}
