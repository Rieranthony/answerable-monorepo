import * as queries from "../db/queries/organization-domains.ts";
import { bindQuery, bindTenantQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/organization-domains.ts";
export const createOrganizationDomain = bindQuery(inPlatformWrite)(
  queries.createOrganizationDomain,
);
export const setOrganizationDomainStatus = bindQuery(inPlatformWrite)(
  queries.setOrganizationDomainStatus,
);
export const organizationAcceptsDomain = bindTenantQuery(
  "memberAccess",
  queries.organizationAcceptsDomain,
);
