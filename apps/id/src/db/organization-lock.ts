import { eq } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { organizations } from "./schema/index.ts";

/** Internal lock primitive for authority establishment and protocol transactions.
 * Callers must establish current authority before exposing data or changing state.
 * Administrative services use the guarded organisation query instead.
 */
export async function lockOrganization(
  executor: Executor,
  id: string,
  mode: "update" | "share" = "update",
) {
  const [row] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .for(mode);
  return row ?? null;
}
