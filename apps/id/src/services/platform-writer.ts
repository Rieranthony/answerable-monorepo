import { eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { hasPlatformWriter } from "../db/queries/grants.ts";
import { oauthResources, systemBindings } from "../db/schema/index.ts";
import { ProblemError } from "../http/problem.ts";

/** Call under the target organisation's exclusive lock, then check after mutation. */
export async function platformWriterCheck(
  tx: Executor,
  organizationId: string,
) {
  const [binding] = await tx
    .select({ resource: oauthResources.identifier })
    .from(systemBindings)
    .innerJoin(oauthResources, eq(oauthResources.id, systemBindings.resourceId))
    .where(eq(systemBindings.organizationId, organizationId));
  const hadWriter = binding && (await hasPlatformWriter(tx, binding));
  return async () => {
    if (binding && hadWriter && !(await hasPlatformWriter(tx, binding)))
      throw new ProblemError(
        409,
        "last_platform_administrator",
        "Keep an effective platform administrator before restricting this authority",
      );
  };
}
