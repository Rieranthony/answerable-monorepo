import { boundedUserAgent } from "../lib/user-agent.ts";
import type { Executor } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";

type Session = {
  id: string;
  userId: string;
  activeOrganizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};
type Context = { headers?: Headers } | null;

export function sessionAuditHooks(db: Executor) {
  async function record(session: Session, context: Context, action: string) {
    await recordAuditEvent(db, {
      actorType: "user",
      actorId: session.userId,
      organizationId: session.activeOrganizationId ?? null,
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
  // Sign-in success is recorded by the sign-in audit plugin, after the SSO
  // plugin has provisioned the membership; the session hook only sees the
  // sign-out, where the session already carries its organisation.
  return {
    delete: {
      after: (session: Session, context: Context) =>
        record(session, context, "auth.signout"),
    },
  };
}
