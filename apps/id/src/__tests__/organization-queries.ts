import * as queries from "../db/queries/organizations.ts";
export type * from "../db/queries/organizations.ts";
import type { Database } from "../db/client.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
import { organizations } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const createOrganization = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createOrganization>>
) =>
  inPlatformWrite(db, (context) =>
    queries.createOrganization(context, ...args),
  );
export const updateOrganization = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateOrganization>>
) =>
  inPlatformWrite(db, (context) =>
    queries.updateOrganization(context, ...args),
  );
export const setOrganizationStatus = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setOrganizationStatus>>
) =>
  inPlatformWrite(db, (context) =>
    queries.setOrganizationStatus(context, ...args),
  );
export const deleteOrganization = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteOrganization>>
) =>
  inPlatformWrite(db, (context) =>
    queries.deleteOrganization(context, ...args),
  );
export const countOrganizationClients = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.countOrganizationClients>>
) =>
  inPlatformWrite(db, (context) =>
    queries.countOrganizationClients(context, ...args),
  );
export const listOrganizations = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listOrganizations>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listOrganizations(context, ...args)),
  );
export const lockOrganization = (db: Database, id: string) =>
  inPlatformWrite(db, (context) =>
    queries.lockOrganizationForCommand(context, id),
  );
/** Fixture persistence assertions, including erased rows. */
export async function findOrganization(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  return row ?? null;
}
