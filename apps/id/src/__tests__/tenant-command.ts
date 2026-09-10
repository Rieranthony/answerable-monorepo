import type { ActorMetadata } from "../services/actor.ts";
import type { Database, Executor } from "../db/client.ts";
import { testEnvironment } from "./support.ts";
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
      principal: { type: "root", grants: [] },
      environment: testEnvironment({
        rootAdminSecret: "service-test",
        rootAdminBreakGlass: true,
      }),
      organizationId,
    });
    try {
      return await context.run(run, metadata);
    } finally {
      context.close();
    }
  });
}

export function inTenantRead<T, Access extends TenantReadAccess>(
  db: Database,
  organizationId: string,
  access: Access,
  run: (context: TenantReadContext<Access>) => Promise<T>,
) {
  return withTenantRead(
    db,
    {
      principal: { type: "root", grants: [] },
      environment: testEnvironment({
        rootAdminSecret: "service-test",
        rootAdminBreakGlass: true,
      }),
      organizationId,
    },
    access,
    run,
  );
}
