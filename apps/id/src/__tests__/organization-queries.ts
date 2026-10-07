import * as queries from "../db/queries/organizations.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformWrite } from "./platform-context.ts";
export type * from "../db/queries/organizations.ts";
export const createOrganization = bindQuery(inPlatformWrite)(
  queries.createOrganization,
);
