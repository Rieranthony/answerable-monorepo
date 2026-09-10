import {
  requirePlatformReadContext,
  requirePlatformWriteContext,
  type PlatformReadContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import { lockResource } from "../resource-lock.ts";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import {
  oauthResources,
  entitlements,
  oauthClientResources,
} from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
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
export function listResources(
  context: PlatformReadContext,
  query: ResourceQuery,
) {
  const { tx: executor } = requirePlatformReadContext(context);
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
export function readResource(context: PlatformReadContext, identifier: string) {
  const { tx } = requirePlatformReadContext(context);
  return lockResource(tx, identifier, "share");
}
export function readResourceForPolicy(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  return lockResource(tx, identifier, "share");
}
export function lockResourceForCommand(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  return lockResource(tx, identifier);
}

/** Shared resources and this tenant's private resources only; registration is not permission. */
export async function findResourceForAccess(
  context: TenantReadContext<"directory">,
  identifier: string,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  const [row] = await tx
    .select({ id: oauthResources.id })
    .from(oauthResources)
    .where(
      and(
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
  const { tx: executor } = requirePlatformWriteContext(context);
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
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(oauthResources)
    .set(patch)
    .where(eq(oauthResources.identifier, identifier))
    .returning();
  return row ?? null;
}
export async function setResourceDisabled(
  context: PlatformWriteContext,
  identifier: string,
  disabled: boolean,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(oauthResources)
    .set({ disabled })
    .where(eq(oauthResources.identifier, identifier))
    .returning();
  return row ?? null;
}
export async function deleteResource(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  await executor
    .delete(oauthResources)
    .where(eq(oauthResources.identifier, identifier));
}
export async function countResourceEntitlements(
  context: PlatformWriteContext,
  identifier: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(eq(entitlements.resource, identifier));
  return row!.count;
}

export function listResourceClients(
  context: PlatformReadContext,
  resource: string,
) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.resourceId, resource))
    .orderBy(desc(oauthClientResources.id));
}

export async function hasResourceClients(
  context: PlatformWriteContext,
  resource: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const rows = await executor
    .select({ id: oauthClientResources.id })
    .from(oauthClientResources)
    .where(eq(oauthClientResources.resourceId, resource))
    .limit(1);
  return rows.length > 0;
}
