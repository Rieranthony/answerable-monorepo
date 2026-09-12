import * as queries from "../db/queries/entitlements.ts";
import { bindQuery, bindTenantQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/entitlements.ts";
/** Test adapters exercise production query authority while preserving fixture call sites. */
export const createEntitlement = bindQuery(inPlatformWrite)(
  queries.createEntitlement,
);
export const updateEntitlement = bindQuery(inPlatformWrite)(
  queries.updateEntitlement,
);
export const setEntitlementStatus = bindQuery(inPlatformWrite)(
  queries.setEntitlementStatus,
);
export const deleteEntitlement = bindQuery(inPlatformWrite)(
  queries.deleteEntitlement,
);
export const listEntitlements = bindTenantQuery(
  "directory",
  queries.listEntitlements,
);
export const findEntitlement = bindTenantQuery(
  "directory",
  queries.findEntitlement,
);

export const listAllEntitlements = bindQuery(inPlatformRead)(
  queries.listAllEntitlements,
);
