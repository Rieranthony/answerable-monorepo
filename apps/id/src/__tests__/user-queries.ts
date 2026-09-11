import * as queries from "../db/queries/users.ts";
import { bindQuery } from "./bind-query.ts";
import {
  inPlatformRead,
  inPlatformUsers,
  inPlatformWrite,
} from "./platform-context.ts";
export type * from "../db/queries/users.ts";
export { retiredEmailFor, UserNotRetirableError } from "../db/queries/users.ts";
export const retireUserEmail = bindQuery(inPlatformUsers)(
  queries.retireUserEmail,
);
export const lockUser = bindQuery(inPlatformUsers)(queries.lockUser);
export const setUserStatus = bindQuery(inPlatformUsers)(queries.setUserStatus);
export const deleteUser = bindQuery(inPlatformWrite)(queries.deleteUser);
export const listUsers = bindQuery(inPlatformRead)(queries.listUsers);
export const findUser = bindQuery(inPlatformRead)(queries.findUser);
export const userExists = bindQuery(inPlatformRead)(queries.userExists);
/** Fixture convenience only; production email filters use the platform directory. */
export const findUserByEmail = (
  db: import("../db/client.ts").Database,
  email: string,
) =>
  inPlatformRead(db, async (context) => {
    const [row] = await queries.listUsers(context, { email, limit: 1 });
    return row ? queries.findUser(context, row.id) : null;
  });
