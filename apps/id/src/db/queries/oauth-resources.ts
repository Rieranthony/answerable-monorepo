import { sql, and, count, desc, eq, or, isNull } from "drizzle-orm";
import type {
  PlatformReadContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import { lockResource } from "../locks.ts";
import {
  oauthResources,
  entitlements,
  oauthClientResources,
} from "../schema/index.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq, contains } from "./lists.ts";
import { createId } from "../../lib/id.ts";

export type ResourceInput = {
  classification?: "platform_shared" | "tenant_owned";
  organizationId?: string | null;
  identifier: string;
  name: string;
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  allowedScopes: string[];
  signingAlgorithm?: "EdDSA" | "ES256" | "RS256";
};
export type ResourcePatch = Partial<
  Omit<
    ResourceInput,
    "identifier" | "signingAlgorithm" | "classification" | "organizationId"
  >
>;
export type ResourceQuery = PageQuery & { q?: string; disabled?: boolean };
export async function listResources(
  context: PlatformReadContext,
  query: ResourceQuery,
) {
  const { tx: executor } = context;
  return cursorPage(
    await executor
      .select()
      .from(oauthResources)
      .where(
        and(
          isNull(oauthResources.deletedAt),
          contains(query.q, oauthResources.name, oauthResources.identifier),
          optionalEq(oauthResources.disabled, query.disabled),
          beforeCursor(oauthResources.id, query.cursor),
        ),
      )
      .orderBy(desc(oauthResources.id))
      .limit(query.limit + 1),
    query.limit,
  );
}
export function readResource(context: PlatformReadContext, identifier: string) {
  const { tx } = context;
  return lockResource(tx, identifier, "share");
}
export async function readResourceForPolicy(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx } = context;
  const row = await lockResource(tx, identifier, "share");
  await context.revalidate();
  return row;
}
export async function lockResourceForCommand(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx } = context;
  const row = await lockResource(tx, identifier);
  await context.revalidate();
  return row;
}

/** Shared resources and this tenant's private resources only; registration is not permission. */
export async function findResourceForAccess(
  context: TenantReadContext<"directory">,
  identifier: string,
) {
  const { tx, organizationId } = context;
  const [row] = await tx
    .select({ id: oauthResources.id })
    .from(oauthResources)
    .where(
      and(
        isNull(oauthResources.deletedAt),
        eq(oauthResources.identifier, identifier),
        or(
          eq(oauthResources.classification, "platform_shared"),
          eq(oauthResources.organizationId, organizationId),
        ),
      ),
    );
  return row ?? null;
}

export async function createResource(
  context: PlatformWriteContext,
  input: ResourceInput,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .insert(oauthResources)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}
export async function updateResource(
  context: PlatformWriteContext,
  identifier: string,
  patch: ResourcePatch,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthResources)
    .set(patch)
    .where(
      and(
        isNull(oauthResources.deletedAt),
        eq(oauthResources.identifier, identifier),
      ),
    )
    .returning();
  return row ?? null;
}
export async function setResourceDisabled(
  context: PlatformWriteContext,
  identifier: string,
  disabled: boolean,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthResources)
    .set({ disabled })
    .where(
      and(
        isNull(oauthResources.deletedAt),
        eq(oauthResources.identifier, identifier),
      ),
    )
    .returning();
  return row ?? null;
}
export async function deleteResource(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthResources)
    .set({ deletedAt: sql`now()`, disabled: true })
    .where(
      and(
        isNull(oauthResources.deletedAt),
        eq(oauthResources.identifier, identifier),
      ),
    )
    .returning();
  return row!;
}
export async function countResourceEntitlements(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(
      and(
        isNull(entitlements.deletedAt),
        eq(entitlements.resource, identifier),
      ),
    );
  return row!.count;
}

export function listResourceClients(
  context: PlatformReadContext,
  resource: string,
) {
  const { tx: executor } = context;
  return executor
    .select()
    .from(oauthClientResources)
    .where(
      and(
        isNull(oauthClientResources.deletedAt),
        eq(oauthClientResources.resourceId, resource),
      ),
    )
    .orderBy(desc(oauthClientResources.id));
}

export async function hasResourceClients(
  context: PlatformWriteContext,
  resource: string,
) {
  const { tx: executor } = context;
  const rows = await executor
    .select({ id: oauthClientResources.id })
    .from(oauthClientResources)
    .where(
      and(
        isNull(oauthClientResources.deletedAt),
        eq(oauthClientResources.resourceId, resource),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
