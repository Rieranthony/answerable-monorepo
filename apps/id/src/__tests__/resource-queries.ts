import * as queries from "../db/queries/oauth-resources.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/oauth-resources.ts";
export const createResource = bindQuery(inPlatformWrite)(
  queries.createResource,
);
