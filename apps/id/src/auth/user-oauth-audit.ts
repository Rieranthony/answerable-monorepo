import { APIError } from "better-auth/api";
import type { Executor } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { grantContexts } from "../db/schema/index.ts";

/** Version four captures durable UUID subjects from the retained immutable grant. */
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
      schemaVersion: 4,
      actorType: input.actor,
      actorId: input.actor === "user" ? input.grant.userId : input.clientId,
      organizationId: input.grant.organizationId,
      action: input.action,
      outcome: input.action === "oauth.user.denied" ? "denied" : "success",
      targetType: "grant_context",
      targetId: input.grant.id,
      requestId: input.requestId ?? null,
      data: { ...input.data, authentication: input.grant.authentication },
    });
  } catch {
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      {
        error: "temporarily_unavailable",
        error_description:
          "The authorisation outcome could not be recorded. Retry the request.",
      },
      { "Retry-After": "1" },
    );
  }
}
