import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { adminOperations } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import type { BearerClaims, Principal } from "../http/principal.ts";
import { ProblemError } from "../http/problem.ts";
import { authorizeCommand } from "./command-authority.ts";

/** Platform audit authority is checked in the receipt's read transaction. */
export function getAuditOperationStatus(
  db: Database,
  id: string,
  caller: {
    principal: Principal;
    environment: Environment;
    claims?: BearerClaims;
  },
) {
  return db.transaction(async (tx) => {
    await authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      { platform: "platform:read" },
      caller.claims,
    );
    const [operation] = await tx
      .select({
        id: adminOperations.id,
        name: adminOperations.name,
        outcome: adminOperations.outcome,
        statusCode: adminOperations.statusCode,
        resultReference: adminOperations.resultReference,
        committedAt: adminOperations.committedAt,
      })
      .from(adminOperations)
      .where(eq(adminOperations.id, id));
    if (!operation)
      throw new ProblemError(404, "not_found", "Operation not found");
    return operation;
  });
}
