import type { Context } from "hono";
import type { AppEnvironment } from "../context.ts";
import {
  withTenantRead,
  type TenantReadContext,
  type TenantReadAccess,
} from "../../services/tenant-context.ts";
export function tenantRead<T, Access extends TenantReadAccess>(
  context: Context<AppEnvironment>,
  access: Access,
  run: (tenant: TenantReadContext<Access>) => Promise<T>,
) {
  context.header("Cache-Control", "no-store");
  return withTenantRead(
    context.get("db"),
    {
      principal: context.get("principal")!,
      environment: context.get("environment"),
      claims: context.get("bearerClaims"),
      organizationId: context.req.param("organizationId")!,
    },
    access,
    run,
  );
}
