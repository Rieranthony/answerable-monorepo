import * as queries from "../db/queries/oauth-clients.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
export {
  findClientPrincipal,
  type ClientPrincipalRow,
} from "../db/client-principal.ts";
export type * from "../db/queries/oauth-clients.ts";
export const listClients = bindQuery(inPlatformRead)(queries.listClients);
export const listClientResources = bindQuery(inPlatformRead)(
  queries.listClientResources,
);
export const createClient = bindQuery(inPlatformWrite)(queries.createClient);
export const updateClient = bindQuery(inPlatformWrite)(queries.updateClient);
export const setClientDisabled = bindQuery(inPlatformWrite)(
  queries.setClientDisabled,
);
export const setClientSecret = bindQuery(inPlatformWrite)(
  queries.setClientSecret,
);
export const linkClientResource = bindQuery(inPlatformWrite)(
  queries.linkClientResource,
);
export const unlinkClientResource = bindQuery(inPlatformWrite)(
  queries.unlinkClientResource,
);
export const countClientEntitlements = bindQuery(inPlatformWrite)(
  queries.countClientEntitlements,
);
export const deleteClient = bindQuery(inPlatformWrite)(queries.deleteClient);
export const findClient = bindQuery(inPlatformWrite)(
  queries.lockClientForCommand,
);
export const lockClient = findClient;
