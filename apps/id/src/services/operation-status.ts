import { lockOrganization } from "../db/organization-lock.ts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "../db/client.ts";
import { adminOperations } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import type { BearerClaims, Principal } from "../http/principal.ts";
import { ProblemError } from "../http/problem.ts";
import { authorizeCommand } from "./command-authority.ts";

export const ownOperationScopes = {
  platform: ["platform:read", "platform:write", "platform:users"],
  org: ["org:read", "org:write", "org:users"],
} as const;

type OperationCaller = {
  principal: Principal;
  environment: Environment;
  claims?: BearerClaims;
};
function operationActor(principal: Principal) {
  return principal.type === "root"
    ? "system:root"
    : principal.type === "user"
      ? `user:${principal.userId}`
      : `client:${principal.clientId}`;
}

/** Authority and actor visibility are decided in the same read transaction. */
export function getAuditOperationStatus(
  db: Database,
  id: string,
  caller: OperationCaller,
  organizationId?: string,
) {
  return db.transaction(async (tx) => {
    // Receipts survive erasure: absence of a live row is not an authority bypass.
    if (organizationId !== undefined)
      await lockOrganization(tx, organizationId, "share");
    const tier = await authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      {
        platform: "platform:read",
        ...(organizationId === undefined
          ? {}
          : { tenant: { organizationId, scope: "org:read" as const } }),
      },
      caller.claims,
    );
    const authorityScope =
      organizationId === undefined ? undefined : `tenant:${organizationId}`;
    return getOperationStatus(
      tx,
      id,
      tier === "platform"
        ? { kind: "platform", authorityScope }
        : {
            kind: "actor",
            authorityScope: authorityScope!,
            actorInstance: operationActor(caller.principal),
          },
    );
  });
}

export function getOwnOperationStatus(
  db: Database,
  id: string,
  caller: OperationCaller,
) {
  const actorInstance = operationActor(caller.principal);
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select({ authorityScope: adminOperations.authorityScope })
      .from(adminOperations)
      .where(
        and(
          eq(adminOperations.id, id),
          eq(adminOperations.actorInstance, actorInstance),
        ),
      );
    if (!operation)
      throw new ProblemError(404, "not_found", "Operation not found");
    const scope = operation.authorityScope;
    const organizationId = scope.startsWith("tenant:")
      ? z.uuid().safeParse(scope.slice(7))
      : undefined;
    if (scope !== "platform" && !organizationId?.success)
      throw new ProblemError(404, "not_found", "Operation not found");
    await authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      {
        platform: ownOperationScopes.platform,
        ...(organizationId?.success
          ? {
              tenant: {
                organizationId: organizationId.data,
                scope: ownOperationScopes.org,
              },
            }
          : {}),
      },
      caller.claims,
    );
    return getOperationStatus(tx, id, {
      kind: "actor",
      authorityScope: scope,
      actorInstance,
    });
  });
}

/** Public projection deliberately excludes request/key digests and replay data. */
async function getOperationStatus(
  db: Executor,
  id: string,
  access:
    | { kind: "platform"; authorityScope?: string }
    | { kind: "actor"; authorityScope: string; actorInstance: string },
) {
  const [operation] = await db
    .select({
      id: adminOperations.id,
      name: adminOperations.name,
      outcome: adminOperations.outcome,
      statusCode: adminOperations.statusCode,
      resultReference: adminOperations.resultReference,
      committedAt: adminOperations.committedAt,
      replayExpiresAt: adminOperations.replayExpiresAt,
      hasPayload: sql<boolean>`exists(select 1 from admin_operation_results where operation_id = ${adminOperations.id})`,
    })
    .from(adminOperations)
    .where(
      and(
        eq(adminOperations.id, id),
        access.authorityScope === undefined
          ? undefined
          : eq(adminOperations.authorityScope, access.authorityScope),
        access.kind === "actor"
          ? eq(adminOperations.actorInstance, access.actorInstance)
          : undefined,
      ),
    );
  if (!operation)
    throw new ProblemError(404, "not_found", "Operation not found");
  const { hasPayload, ...visible } = operation;
  const replay =
    operation.replayExpiresAt === null
      ? ("reference" as const)
      : hasPayload && operation.replayExpiresAt.getTime() > Date.now()
        ? ("available" as const)
        : ("expired" as const);
  return { ...visible, replay };
}
