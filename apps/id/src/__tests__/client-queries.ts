import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/oauth-clients.ts";
import { oauthClients } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformWrite } from "./platform-context.ts";
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
export const lockClient = bindQuery(inPlatformWrite)(
  queries.lockClientForCommand,
);

/** A client no organisation owns, as hosts are registered: every organisation's
 * entitlements and capabilities may name it. */
export async function createSharedClient(db: Database) {
  const clientId = `shared-${createId()}`;
  await db.insert(oauthClients).values({
    id: createId(),
    clientId,
    name: "Shared app",
    redirectUris: [],
  });
  return clientId;
}
