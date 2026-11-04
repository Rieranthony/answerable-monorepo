import type {
  PlatformUsersContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import type { TenantMemberContext } from "../../services/tenant-context.ts";
import { and, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { grantContexts, ssoProviders } from "../schema/index.ts";

/** Irreversibly revoke the live grant contexts `where` selects. Callers add
 * `.returning(…)` when the rows are audit effects. */
export function revokeGrantContexts(executor: Executor, where: SQL) {
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(and(where, isNull(grantContexts.revokedAt)));
}

/** Tenant-local revocation; returning rows are the actual audit effects. */
export function revokeMemberGrantContexts(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
  return revokeGrantContexts(
    executor,
    and(
      eq(grantContexts.organizationId, organizationId),
      eq(grantContexts.memberId, memberId),
    )!,
  ).returning({ id: grantContexts.id });
}

export function revokeUserGrantContexts(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    eq(grantContexts.userId, userId),
  ).returning({
    id: grantContexts.id,
    organizationId: grantContexts.organizationId,
  });
}

/** Erasure's revocation: the same rows as revokeUserGrantContexts, under platform write. */
export function revokeErasedUserGrantContexts(
  context: PlatformWriteContext,
  userId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    eq(grantContexts.userId, userId),
  ).returning({
    id: grantContexts.id,
    organizationId: grantContexts.organizationId,
    userId: grantContexts.userId,
  });
}

export function revokeOrganizationGrantContexts(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    eq(grantContexts.organizationId, organizationId),
  ).returning({ id: grantContexts.id, userId: grantContexts.userId });
}

/** A directory command's revocation: everything but this firm's magic-link origin, since links
 * and a directory are independent. */
export function revokeDirectoryGrantContexts(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    and(
      eq(grantContexts.organizationId, organizationId),
      notInArray(
        grantContexts.authenticationProviderId,
        executor
          .select({ id: ssoProviders.id })
          .from(ssoProviders)
          .where(
            and(
              eq(ssoProviders.organizationId, organizationId),
              eq(ssoProviders.kind, "magic_link"),
            ),
          ),
      ),
    )!,
  ).returning({ id: grantContexts.id, userId: grantContexts.userId });
}

export function revokeResourceGrantContexts(
  context: PlatformWriteContext,
  resourceInstanceId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    eq(grantContexts.resourceInstanceId, resourceInstanceId),
  ).returning({
    id: grantContexts.id,
    organizationId: grantContexts.organizationId,
    userId: grantContexts.userId,
  });
}

export function revokeClientGrantContexts(
  context: PlatformWriteContext,
  clientInstanceId: string,
) {
  const { tx: executor } = context;
  return revokeGrantContexts(
    executor,
    eq(grantContexts.clientInstanceId, clientInstanceId),
  ).returning({
    id: grantContexts.id,
    organizationId: grantContexts.organizationId,
    userId: grantContexts.userId,
  });
}
