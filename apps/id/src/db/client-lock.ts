import { eq } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { oauthClients } from "./schema/index.ts";

/** Internal client lock for authenticated protocol transactions.
 * Administrative callers use the guarded client queries.
 */
export async function lockClient(
  executor: Executor,
  clientId: string,
  mode: "update" | "share" = "update",
) {
  const [row] = await executor
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .for(mode);
  return row ?? null;
}
