import { boundedUserAgent } from "../lib/user-agent.ts";
import type { BetterAuthPlugin } from "better-auth";
import type { GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import type { Database } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";

type SessionRow = {
  id: string;
  token: string;
  activeOrganizationId?: string | null;
  authenticationOrganizationId?: string | null;
  authenticationProviderId?: string | null;
  authenticationProviderRevision?: number | null;
  authenticationAccountId?: string | null;
  upstreamAuthTime?: Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Version two attributes success to the native session's verified origin.
 * Memberships and the browser's selected organisation never supply provenance.
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
  const { session } = newSession;
  const organizationId = session.authenticationOrganizationId ?? null;
  await recordAuditEvent(db, {
    schemaVersion: 2,
    actorType: "user",
    actorId: newSession.user.id,
    organizationId,
    action: "auth.signin.succeeded",
    targetType: "session",
    targetId: session.id,
    outcome: "success",
    requestId: ctx.headers?.get("x-request-id") ?? null,
    ip: null,
    userAgent: boundedUserAgent(session.userAgent),
    data: {
      authenticationAccountId: session.authenticationAccountId ?? null,
      authenticationProviderId: session.authenticationProviderId ?? null,
      authenticationProviderRevision:
        session.authenticationProviderRevision ?? null,
      upstreamAuthTime: session.upstreamAuthTime?.toISOString() ?? null,
    },
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
