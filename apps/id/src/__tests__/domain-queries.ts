import { and, eq } from "drizzle-orm";
import { organizationDomains } from "../db/schema/index.ts";
import * as queries from "../db/queries/organization-domains.ts";
export type * from "../db/queries/organization-domains.ts";
import type { Database } from "../db/client.ts";
import { inTenantRead } from "./tenant-command.ts";
import { inPlatformWrite } from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const createOrganizationDomain = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createOrganizationDomain>>
) =>
  inPlatformWrite(db, (context) =>
    queries.createOrganizationDomain(context, ...args),
  );
export const setOrganizationDomainStatus = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setOrganizationDomainStatus>>
) =>
  inPlatformWrite(db, (context) =>
    queries.setOrganizationDomainStatus(context, ...args),
  );
export const deleteOrganizationDomain = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteOrganizationDomain>>
) =>
  inPlatformWrite(db, (context) =>
    queries.deleteOrganizationDomain(context, ...args),
  );
export const listOrganizationDomains = (
  db: Database,
  organizationId: string,
  ...args: Tail<Parameters<typeof queries.listOrganizationDomains>>
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    Promise.resolve(queries.listOrganizationDomains(context, ...args)),
  );
/** Fixture assertion only: production reads list domains; commands use the locked lookup. */
export async function findOrganizationDomain(
  db: Database,
  organizationId: string,
  domainId: string,
) {
  const [row] = await db
    .select()
    .from(organizationDomains)
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
  return row ?? null;
}
export const organizationAcceptsDomain = (
  db: Database,
  organizationId: string,
  ...args: Tail<Parameters<typeof queries.organizationAcceptsDomain>>
) =>
  inTenantRead(db, organizationId, "memberAccess", (context) =>
    Promise.resolve(queries.organizationAcceptsDomain(context, ...args)),
  );
