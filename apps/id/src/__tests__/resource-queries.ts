import * as queries from "../db/queries/oauth-resources.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/oauth-resources.ts";
export const listResources = bindQuery(inPlatformRead)(queries.listResources);
export const listResourceClients = bindQuery(inPlatformRead)(
  queries.listResourceClients,
);
export const createResource = bindQuery(inPlatformWrite)(
  queries.createResource,
);
export const updateResource = bindQuery(inPlatformWrite)(
  queries.updateResource,
);
export const setResourceDisabled = bindQuery(inPlatformWrite)(
  queries.setResourceDisabled,
);
export const deleteResource = bindQuery(inPlatformWrite)(
  queries.deleteResource,
);
export const countResourceEntitlements = bindQuery(inPlatformWrite)(
  queries.countResourceEntitlements,
);
export const hasResourceClients = bindQuery(inPlatformWrite)(
  queries.hasResourceClients,
);
export const findResource = bindQuery(inPlatformRead)(queries.readResource);
export const lockResource = bindQuery(inPlatformWrite)(
  queries.lockResourceForCommand,
);
