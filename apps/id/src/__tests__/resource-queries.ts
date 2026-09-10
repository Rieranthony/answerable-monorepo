import * as queries from "../db/queries/oauth-resources.ts";
export type * from "../db/queries/oauth-resources.ts";
import type { Database } from "../db/client.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const listResources = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listResources>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listResources(context, ...args)),
  );
export const listResourceClients = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listResourceClients>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listResourceClients(context, ...args)),
  );
export const createResource = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createResource>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.createResource(context, ...args)),
  );
export const updateResource = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateResource>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.updateResource(context, ...args)),
  );
export const setResourceDisabled = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setResourceDisabled>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.setResourceDisabled(context, ...args)),
  );
export const deleteResource = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteResource>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.deleteResource(context, ...args)),
  );
export const countResourceEntitlements = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.countResourceEntitlements>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.countResourceEntitlements(context, ...args)),
  );
export const hasResourceClients = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.hasResourceClients>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.hasResourceClients(context, ...args)),
  );
export const findResource = (db: Database, identifier: string) =>
  inPlatformRead(db, (context) => queries.readResource(context, identifier));
export const lockResource = (db: Database, identifier: string) =>
  inPlatformWrite(db, (context) =>
    queries.lockResourceForCommand(context, identifier),
  );
