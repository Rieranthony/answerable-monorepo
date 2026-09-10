import {
  requirePlatformUsersContext,
  requirePlatformWriteContext,
  type PlatformUsersContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantMemberContext,
  type TenantMemberContext,
} from "../../services/tenant-context.ts";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { grantContexts, oauthClients } from "../schema/index.ts";

/** Irreversible tenant-local revocation; returning rows are the actual audit effects. */
export function revokeMemberGrantContexts(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = requireTenantMemberContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(grantContexts.organizationId, organizationId),
        eq(grantContexts.memberId, memberId),
        isNull(grantContexts.revokedAt),
      ),
    )
    .returning({ id: grantContexts.id });
}

export function revokeUserGrantContexts(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx: executor } = requirePlatformUsersContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(eq(grantContexts.userId, userId), isNull(grantContexts.revokedAt)),
    )
    .returning({
      id: grantContexts.id,
      organizationId: grantContexts.organizationId,
    });
}

/** Revoke contexts belonging to the user and to their owned clients. */
export function revokeUserAndOwnedClientGrantContexts(
  context: PlatformWriteContext,
  userId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        isNull(grantContexts.revokedAt),
        or(
          eq(grantContexts.userId, userId),
          inArray(
            grantContexts.clientInstanceId,
            executor
              .select({ id: oauthClients.id })
              .from(oauthClients)
              .where(
                and(
                  isNull(oauthClients.deletedAt),
                  eq(oauthClients.userId, userId),
                ),
              ),
          ),
        ),
      ),
    )
    .returning({
      id: grantContexts.id,
      organizationId: grantContexts.organizationId,
      userId: grantContexts.userId,
    });
}

export function revokeOrganizationGrantContexts(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(grantContexts.organizationId, organizationId),
        isNull(grantContexts.revokedAt),
      ),
    )
    .returning({ id: grantContexts.id, userId: grantContexts.userId });
}

export function revokeSessionGrantContexts(
  context: PlatformUsersContext,
  userId: string,
  sessionId: string,
) {
  const { tx: executor } = requirePlatformUsersContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(grantContexts.userId, userId),
        eq(grantContexts.authenticationSessionId, sessionId),
        isNull(grantContexts.revokedAt),
      ),
    )
    .returning({
      id: grantContexts.id,
      organizationId: grantContexts.organizationId,
    });
}

export function revokeResourceGrantContexts(
  context: PlatformWriteContext,
  resourceInstanceId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(grantContexts.resourceInstanceId, resourceInstanceId),
        isNull(grantContexts.revokedAt),
      ),
    )
    .returning({
      id: grantContexts.id,
      organizationId: grantContexts.organizationId,
      userId: grantContexts.userId,
    });
}

export function revokeClientGrantContexts(
  context: PlatformWriteContext,
  clientInstanceId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  return executor
    .update(grantContexts)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(grantContexts.clientInstanceId, clientInstanceId),
        isNull(grantContexts.revokedAt),
      ),
    )
    .returning({
      id: grantContexts.id,
      organizationId: grantContexts.organizationId,
      userId: grantContexts.userId,
    });
}
