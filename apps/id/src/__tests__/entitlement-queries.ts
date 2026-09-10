type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
import * as queries from "../db/queries/entitlements.ts";
export type * from "../db/queries/entitlements.ts";
import type { Database } from "../db/client.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
import { inTenantRead } from "./tenant-command.ts";
/** Test adapters exercise production query authority while preserving fixture call sites. */
export const createEntitlement = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createEntitlement>>
) =>
  inPlatformWrite(db, (context) => queries.createEntitlement(context, ...args));
export const updateEntitlement = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateEntitlement>>
) =>
  inPlatformWrite(db, (context) => queries.updateEntitlement(context, ...args));
export const setEntitlementStatus = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setEntitlementStatus>>
) =>
  inPlatformWrite(db, (context) =>
    queries.setEntitlementStatus(context, ...args),
  );
export const deleteEntitlement = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteEntitlement>>
) =>
  inPlatformWrite(db, (context) => queries.deleteEntitlement(context, ...args));
export const listEntitlements = (
  db: Database,
  organizationId: string,
  ...args: Tail<Parameters<typeof queries.listEntitlements>>
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.listEntitlements(context, ...args),
  );
export const findEntitlement = (
  db: Database,
  organizationId: string,
  entitlementId: string,
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.findEntitlement(context, entitlementId),
  );

export const listAllEntitlements = (
  db: Database,
  query: queries.EntitlementQuery,
) =>
  inPlatformRead(db, (context) => queries.listAllEntitlements(context, query));
