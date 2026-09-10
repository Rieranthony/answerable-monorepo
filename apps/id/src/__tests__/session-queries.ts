import * as queries from "../db/queries/sessions.ts";
import type { Database } from "../db/client.ts";
import { inPlatformRead, inPlatformUsers } from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const deleteUserSessionIds = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteUserSessionIds>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.deleteUserSessionIds(context, ...args)),
  );
export const listUserSessions = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listUserSessions>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listUserSessions(context, ...args)),
  );
export const deleteSession = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteSession>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.deleteSession(context, ...args)),
  );
export const findUserSession = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.findUserSession>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.findUserSession(context, ...args)),
  );
