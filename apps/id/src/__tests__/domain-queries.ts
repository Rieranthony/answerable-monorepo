import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/organization-domains.ts";
import { organizationDomains } from "../db/schema/index.ts";
import { bindQuery, bindTenantQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/organization-domains.ts";
export const createOrganizationDomain = bindQuery(inPlatformWrite)(
  queries.createOrganizationDomain,
);
export const setOrganizationDomainStatus = bindQuery(inPlatformWrite)(
  queries.setOrganizationDomainStatus,
);
export const deleteOrganizationDomain = bindQuery(inPlatformWrite)(
  queries.deleteOrganizationDomain,
);
export const listOrganizationDomains = bindTenantQuery(
  "directory",
  queries.listOrganizationDomains,
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
export const organizationAcceptsDomain = bindTenantQuery(
  "memberAccess",
  queries.organizationAcceptsDomain,
);
