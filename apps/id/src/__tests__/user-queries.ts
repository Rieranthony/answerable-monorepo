import * as queries from "../db/queries/users.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformUsers } from "./platform-context.ts";
export type * from "../db/queries/users.ts";
export const retireUserEmail = bindQuery(inPlatformUsers)(
  queries.retireUserEmail,
);
