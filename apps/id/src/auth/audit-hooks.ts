import { boundedUserAgent } from "../lib/user-agent.ts";
import type { Executor } from "../db/client.ts";
import { recordAuditEvent, type AuditAction } from "../db/queries/audit.ts";

type Session = {
  id: string;
  userId: string;
  authenticationOrganizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};
type Context = { path?: string; headers?: Headers } | null;

export function sessionAuditHooks(db: Executor) {
  async function record(
    session: Session,
    context: Context,
    action: AuditAction,
  ) {
    await recordAuditEvent(db, {
      actorType: "user",
      actorId: session.userId,
      organizationId: session.authenticationOrganizationId ?? null,
      action,
      targetType: "session",
      targetId: session.id,
      outcome: "success",
      requestId: context?.headers?.get("x-request-id") ?? null,
      // Existing session IPs have no recorded trust provenance.
      ip: null,
      userAgent: boundedUserAgent(session.userAgent),
    });
  }
  // Sign-in success commits in the SSO session-creation transaction. Better Auth
  // also deletes an expired session it reads; only /sign-out is a sign-out.
  return {
    delete: {
      after: async (session: Session, context: Context) => {
        if (context?.path === "/sign-out")
          await record(session, context, "auth.signout");
      },
    },
  };
}
