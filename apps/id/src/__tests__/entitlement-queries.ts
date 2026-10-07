import * as queries from "../db/queries/entitlements.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/entitlements.ts";
/** Test adapters exercise production query authority while preserving fixture call sites. */
export const createEntitlement = bindQuery(inPlatformWrite)(
  queries.createEntitlement,
);
export const deleteEntitlement = bindQuery(inPlatformWrite)(
  queries.deleteEntitlement,
);
