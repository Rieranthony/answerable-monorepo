import type { Database } from "../db/client.ts";

/** Bind fixture queries to the real authority issuer without repeating their signatures. */
export function bindQuery<Context>(
  issue: <Result>(
    db: Database,
    run: (context: Context) => Promise<Result>,
  ) => Promise<Result>,
) {
  return <Args extends unknown[], Result>(
      query: (context: Context, ...args: Args) => Promise<Result>,
    ) =>
    (db: Database, ...args: Args): Promise<Result> =>
      issue(db, (context) => query(context, ...args));
}

import { inTenantRead } from "./tenant-command.ts";
import type {
  TenantReadAccess,
  TenantReadContext,
} from "../services/tenant-context.ts";

export function bindTenantQuery<
  Access extends TenantReadAccess,
  Args extends unknown[],
  Result,
>(
  access: Access,
  query: (context: TenantReadContext<Access>, ...args: Args) => Promise<Result>,
) {
  return (db: Database, organizationId: string, ...args: Args) =>
    bindQuery<TenantReadContext<Access>>((db, run) =>
      inTenantRead(db, organizationId, access, run),
    )(query)(db, ...args);
}
