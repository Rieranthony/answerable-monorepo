import * as queries from "../db/queries/oauth-clients.ts";
export type * from "../db/queries/oauth-clients.ts";
export {
  findClientPrincipal,
  type ClientPrincipalRow,
} from "../db/client-principal.ts";
import type { Database } from "../db/client.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const listClients = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listClients>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listClients(context, ...args)),
  );
export const listClientResources = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listClientResources>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listClientResources(context, ...args)),
  );
export const createClient = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createClient>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.createClient(context, ...args)),
  );
export const updateClient = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateClient>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.updateClient(context, ...args)),
  );
export const setClientDisabled = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setClientDisabled>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.setClientDisabled(context, ...args)),
  );
export const setClientSecret = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setClientSecret>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.setClientSecret(context, ...args)),
  );
export const linkClientResource = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.linkClientResource>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.linkClientResource(context, ...args)),
  );
export const unlinkClientResource = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.unlinkClientResource>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.unlinkClientResource(context, ...args)),
  );
export const countClientEntitlements = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.countClientEntitlements>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.countClientEntitlements(context, ...args)),
  );
export const deleteClient = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteClient>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.deleteClient(context, ...args)),
  );
export const findClient = (db: Database, clientId: string) =>
  inPlatformWrite(db, (context) =>
    queries.lockClientForCommand(context, clientId),
  );
export const lockClient = findClient;
