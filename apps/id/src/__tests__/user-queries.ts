import * as queries from "../db/queries/users.ts";
export type * from "../db/queries/users.ts";
export { retiredEmailFor, UserNotRetirableError } from "../db/queries/users.ts";
import type { Database } from "../db/client.ts";
import {
  inPlatformRead,
  inPlatformUsers,
  inPlatformWrite,
} from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const retireUserEmail = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.retireUserEmail>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.retireUserEmail(context, ...args)),
  );
export const lockUser = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.lockUser>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.lockUser(context, ...args)),
  );
export const setUserStatus = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setUserStatus>>
) =>
  inPlatformUsers(db, (context) =>
    Promise.resolve(queries.setUserStatus(context, ...args)),
  );
export const deleteUser = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteUser>>
) =>
  inPlatformWrite(db, (context) =>
    Promise.resolve(queries.deleteUser(context, ...args)),
  );
export const listUsers = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.listUsers>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.listUsers(context, ...args)),
  );
export const findUser = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.findUser>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.findUser(context, ...args)),
  );
export const userExists = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.userExists>>
) =>
  inPlatformRead(db, (context) =>
    Promise.resolve(queries.userExists(context, ...args)),
  );
/** Fixture convenience only; production email filters use the platform directory. */
export const findUserByEmail = (db: Database, email: string) =>
  inPlatformRead(db, async (context) => {
    const [row] = await queries.listUsers(context, { email, limit: 1 });
    return row ? queries.findUser(context, row.id) : null;
  });
