import { eq } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { oauthResources } from "./schema/index.ts";

/** Internal resource lock for authenticated protocol transactions.
 * Administrative callers use the context-guarded resource queries.
 */
export async function lockResource(
  executor: Executor,
  identifier: string,
  mode: "update" | "share" = "update",
) {
  const [row] = await executor
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.identifier, identifier))
    .for(mode);
  return row ?? null;
}
