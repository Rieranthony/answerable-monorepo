import * as queries from "../db/queries/sso-providers.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/sso-providers.ts";
export {
  redactSsoProvider,
  serializeSsoProviderConfig,
} from "../db/queries/sso-providers.ts";
export const createSsoProvider = bindQuery(inPlatformWrite)(
  queries.createSsoProvider,
);
export const updateSsoProvider = bindQuery(inPlatformWrite)(
  queries.updateSsoProvider,
);
export const deleteSsoProvider = bindQuery(inPlatformWrite)(
  queries.deleteSsoProvider,
);
export const findSsoProviderByOrganization = bindQuery(inPlatformWrite)(
  queries.findSsoProviderForCommand,
);
