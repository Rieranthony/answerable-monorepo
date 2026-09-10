import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { createId } from "../lib/id.ts";

/** The retention role can invoke this bounded, audited function and cannot read payloads. */
export async function purgeOperationResults(db: Database, batchSize = 1000) {
  const result = await db.execute<{ count: number }>(
    sql`select public.purge_operation_results(${createId()}::uuid, ${batchSize}) as count`,
  );
  return result.rows[0]!.count;
}
