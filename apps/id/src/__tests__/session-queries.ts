import * as queries from "../db/queries/sessions.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead, inPlatformUsers } from "./platform-context.ts";
export const deleteUserSessionIds = bindQuery(inPlatformUsers)(
  queries.deleteUserSessionIds,
);
export const listUserSessions = bindQuery(inPlatformRead)(
  queries.listUserSessions,
);
export const deleteSession = bindQuery(inPlatformUsers)(queries.deleteSession);
export const findUserSession = bindQuery(inPlatformUsers)(
  queries.findUserSession,
);
