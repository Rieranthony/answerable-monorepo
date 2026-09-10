import type { Database } from "../../db/client.ts";
import { databaseBusy } from "../problem.ts";

const active = new WeakMap<Database["$client"], Map<string, number>>();

/** Called after route authentication/validation, before journal checkout.
 * Capacity is not authority: admitted commands still re-authorise in the journal.
 * Share the bound across app objects using the same pool; retain no idle tenant keys.
 */
export async function withOrganizationCommandSlot<T>(
  db: Database,
  organizationId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (organizationId === undefined) return run();
  const key = organizationId.toLowerCase();
  const counts = active.get(db.$client) ?? new Map<string, number>();
  const count = counts.get(key) ?? 0;
  if (count >= 2) throw databaseBusy();
  active.set(db.$client, counts);
  counts.set(key, count + 1);
  try {
    return await run();
  } finally {
    const remaining = counts.get(key)! - 1;
    if (remaining === 0) counts.delete(key);
    else counts.set(key, remaining);
  }
}
