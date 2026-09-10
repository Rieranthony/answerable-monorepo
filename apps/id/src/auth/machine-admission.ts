import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";

/** Two signing transactions per verified owner, shared across database connections.
 * Transaction locks release on commit/rollback; this does not bound pool checkout.
 */
export async function admitMachineIssuance(
  tx: Executor,
  organizationId: string,
) {
  for (let slot = 0; slot < 2; slot++) {
    const result = await tx.execute(sql`select pg_try_advisory_xact_lock(
      hashtextextended(${`machine-issuance:${organizationId}:${slot}`}, 0)
    ) as acquired`);
    if (result.rows[0]!.acquired) return;
  }
  throw new APIError(
    "SERVICE_UNAVAILABLE",
    {
      error: "temporarily_unavailable",
      error_description:
        "Tenant token issuance is busy. Retry the token request.",
    },
    { "Retry-After": "1" },
  );
}
