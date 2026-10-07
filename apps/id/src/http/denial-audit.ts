import type { Database } from "../db/client.ts";
import { recordAuditEvent, type AuditEventInput } from "../db/queries/audit.ts";
import { errorFields } from "./problem.ts";

/** A refusal stays refused when its evidence cannot be stored. Never use for admission or mutation success. */
export async function recordAdministrativeDenial(
  db: Database,
  event: Omit<AuditEventInput, "outcome">,
) {
  try {
    await recordAuditEvent(db, { ...event, outcome: "denied" });
  } catch (error) {
    console.error(
      "[id] audit",
      JSON.stringify({
        event: "admin_denial_audit_unavailable",
        requestId: event.requestId ?? null,
        ...errorFields(error),
      }),
    );
  }
}
