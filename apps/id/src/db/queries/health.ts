import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export async function checkDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}
