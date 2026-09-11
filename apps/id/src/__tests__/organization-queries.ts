import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/organizations.ts";
import { organizations } from "../db/schema/index.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/organizations.ts";
export const createOrganization = bindQuery(inPlatformWrite)(
  queries.createOrganization,
);
export const updateOrganization = bindQuery(inPlatformWrite)(
  queries.updateOrganization,
);
export const setOrganizationStatus = bindQuery(inPlatformWrite)(
  queries.setOrganizationStatus,
);
export const deleteOrganization = bindQuery(inPlatformWrite)(
  queries.deleteOrganization,
);
export const countOrganizationClients = bindQuery(inPlatformWrite)(
  queries.countOrganizationClients,
);
export const listOrganizations = bindQuery(inPlatformRead)(
  queries.listOrganizations,
);
export const lockOrganization = bindQuery(inPlatformWrite)(
  queries.lockOrganizationForCommand,
);
/** Fixture persistence assertions, including erased rows. */
export async function findOrganization(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  return row ?? null;
}
