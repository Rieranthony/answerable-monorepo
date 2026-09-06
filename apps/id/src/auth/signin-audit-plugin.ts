import { getCurrentAdapter, type BetterAuthPlugin } from "better-auth";
import type { GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import type { Database } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";

type SessionRow = {
  id: string;
  token: string;
  activeOrganizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Records a successful sign-in once the SSO plugin has provisioned the
 * membership (its own after-hook runs first because this plugin is listed
 * after it). When the user is an active member of exactly one active
 * organisation, the row and the session carry that organisation.
 */
export async function attributeSignIn(
  db: Database,
  ctx: GenericEndpointContext,
): Promise<string | null> {
  const newSession = ctx.context.newSession as {
    session: SessionRow;
    user: { id: string };
  } | null;
  if (!newSession) return null;
  const adapter = await getCurrentAdapter(ctx.context.adapter);
  const memberships = await adapter.findMany<{ organizationId: string }>({
    model: "member",
    where: [{ field: "userId", value: newSession.user.id }],
  });
  const organizationIds = [
    ...new Set(memberships.map((row) => row.organizationId)),
  ];
  const organizations =
    organizationIds.length === 0
      ? []
      : await adapter.findMany<{ id: string }>({
          model: "organization",
          where: [
            { field: "id", value: organizationIds, operator: "in" },
            { field: "status", value: "active" },
          ],
        });
  const organizationId =
    organizations.length === 1 ? organizations[0]!.id : null;
  const { session } = newSession;
  if (organizationId && session.activeOrganizationId !== organizationId) {
    await ctx.context.internalAdapter.updateSession(session.token, {
      activeOrganizationId: organizationId,
    });
  }
  await recordAuditEvent(db, {
    actorType: "user",
    actorId: newSession.user.id,
    organizationId,
    action: "auth.signin.succeeded",
    targetType: "session",
    targetId: session.id,
    outcome: "success",
    requestId: ctx.headers?.get("x-request-id") ?? null,
    ip: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
  });
  return organizationId;
}

export function isSsoCallbackPath(path: string): boolean {
  return path.startsWith("/sso/callback") || path.startsWith("/callback/");
}

export function signInAudit(db: Database): BetterAuthPlugin {
  return {
    id: "answerable-signin-audit",
    hooks: {
      after: [
        {
          matcher: (ctx) => isSsoCallbackPath(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            await attributeSignIn(db, ctx);
          }),
        },
      ],
    },
  };
}
