import type { Database } from "../db/client.ts";
import { checkDatabase } from "../db/queries/health.ts";

export async function checkReadiness(db: Database): Promise<void> {
  await checkDatabase(db);
}
