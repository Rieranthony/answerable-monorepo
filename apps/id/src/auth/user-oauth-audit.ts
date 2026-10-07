import type { Executor } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { grantContexts } from "../db/schema/index.ts";
import { temporarilyUnavailable } from "./grant-error.ts";

/** The audit row targets the retained, immutable grant; its subject is the grant's user. */
export async function recordUserOAuth(
  tx: Executor,
  input: {
    action:
      | "oauth.user.authorized"
      | "oauth.user.denied"
      | "oauth.user.issued"
      | "oauth.user.replayed"
      | "oauth.user.revoked";
    grant: typeof grantContexts.$inferSelect;
    clientId: string;
    actor: "user" | "client";
    requestId?: string | null;
    data?: Record<string, unknown>;
  },
) {
  try {
    await recordAuditEvent(tx, {
      actorType: input.actor,
      actorId: input.actor === "user" ? input.grant.userId : input.clientId,
      organizationId: input.grant.organizationId,
      action: input.action,
      outcome: input.action === "oauth.user.denied" ? "denied" : "success",
      targetType: "grant_context",
      targetId: input.grant.id,
      requestId: input.requestId ?? null,
      data: input.data ?? null,
    });
  } catch {
    throw temporarilyUnavailable(
      "The authorisation outcome could not be recorded. Retry the request.",
    );
  }
}
