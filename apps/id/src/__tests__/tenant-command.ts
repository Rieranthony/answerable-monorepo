import type { ActorMetadata } from "../services/actor.ts";
import type { Database, Executor } from "../db/client.ts";
import { rootAuthority } from "./platform-context.ts";
import {
  authorizeTenantMemberCommand,
  withTenantRead,
  type TenantReadContext,
  type TenantReadAccess,
  type TenantMemberContext,
} from "../services/tenant-context.ts";
/** Exercise the production context factory and transaction lifetime in service tests. */
export async function inTenant<T>(
  db: Executor,
  organizationId: string,
  run: (context: TenantMemberContext) => Promise<T>,
  metadata: ActorMetadata = { requestId: "service-test" },
) {
  return db.transaction(async (tx) => {
    const context = await authorizeTenantMemberCommand(tx, {
      ...rootAuthority,
      organizationId,
    });
    return context.run(run, metadata);
  });
}

export function inTenantRead<T, Access extends TenantReadAccess>(
  db: Database,
  organizationId: string,
  access: Access,
  run: (context: TenantReadContext<Access>) => Promise<T>,
) {
  return withTenantRead(db, { ...rootAuthority, organizationId }, access, run);
}
