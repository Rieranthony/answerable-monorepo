import {
  actorIdentity,
  commandActor,
  type Actor,
  type ActorMetadata,
} from "./actor.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import type { Database, Executor } from "../db/client.ts";
import { lockOrganization } from "../db/organization-lock.ts";
import type { Environment } from "../env.ts";
import type { Principal, BearerClaims } from "../http/principal.ts";
import { ProblemError } from "../http/problem.ts";
import { authorizeCommand } from "./command-authority.ts";
import { platformWriterCheck } from "./platform-writer.ts";

const tenantCommand = Symbol("tenantCommand");
const issuedContexts = new WeakSet<object>();
type ScopedContext<Access extends string> = Readonly<{
  [tenantCommand]: true;
  access: Access;
  tx: Executor;
  organizationId: string;
}>;

export type TenantMemberContext = ScopedContext<"command"> & {
  readonly revalidate: () => Promise<void>;
  readonly actor: Readonly<Actor>;
};
const readScopes = {
  directory: { platform: "platform:read", tenant: "org:read" },
  configuration: { platform: "platform:users", tenant: "org:users" },
  memberAccess: { platform: "platform:read", tenant: "org:users" },
  history: { platform: "platform:read", tenant: "org:read" },
} as const;
export type TenantReadAccess = keyof typeof readScopes;
export type TenantReadContext<Access extends TenantReadAccess> =
  ScopedContext<Access>;

type TenantAuthority = {
  freshAuthentication?: boolean;
  principal: Principal;
  environment: Environment;
  claims?: BearerClaims;
  organizationId: string;
};

/** Called inside the operation transaction, before mutation or replay. */
export async function authorizeTenantMemberCommand(
  tx: Executor,
  input: TenantAuthority,
) {
  input = { ...input, principal: { ...input.principal } };
  const identity = actorIdentity(input.principal);
  // Serialise member writes with other tenant authority changes.
  // Re-read authority after any preceding tenant revocation has committed.
  const organization = await lockOrganization(tx, input.organizationId);
  const authorize = () =>
    authorizeCommand(
      tx,
      input.principal,
      input.environment,
      {
        platform: "platform:users",
        tenant: { organizationId: input.organizationId, scope: "org:users" },
        freshAuthentication: input.freshAuthentication,
      },
      input.claims,
    );
  await authorize();
  if (!organization)
    throw new ProblemError(404, "not_found", "Organisation not found");
  await setDatabaseScope(tx, {
    kind: "tenant",
    access: "write",
    organizationId: input.organizationId,
  });
  let active = true;
  return {
    close() {
      active = false;
    },
    async run<T>(
      run: (context: TenantMemberContext) => Promise<T>,
      metadata: ActorMetadata,
    ): Promise<T> {
      if (!active)
        throw new Error("Invalid or expired tenant command authorisation");
      active = false;
      const context = Object.freeze({
        [tenantCommand]: true as const,
        access: "command" as const,
        tx,
        organizationId: organization.id,
        actor: commandActor(identity, metadata),
        async revalidate() {
          if (input.principal.type === "user") await authorize();
        },
      });
      issuedContexts.add(context);
      try {
        const checkWriter = await platformWriterCheck(tx, organization.id);
        await context.revalidate();
        const result = await run(context);
        await checkWriter();
        return result;
      } finally {
        issuedContexts.delete(context);
      }
    },
  };
}

/** Reject reconstructed contexts and contexts whose command callback has ended. */
export function requireTenantMemberContext(context: TenantMemberContext) {
  if (!issuedContexts.has(context) || context.access !== "command")
    throw new Error("Invalid or expired tenant member context");
  return context;
}

/** Scope and transaction lifetime are fixed here, rather than supplied by readers. */
export async function withTenantRead<T, Access extends TenantReadAccess>(
  db: Database,
  input: TenantAuthority,
  access: Access,
  run: (context: TenantReadContext<Access>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const organization = await lockOrganization(
      tx,
      input.organizationId,
      "share",
    );
    await authorizeCommand(
      tx,
      input.principal,
      input.environment,
      {
        platform: readScopes[access].platform,
        tenant: {
          organizationId: input.organizationId,
          scope: readScopes[access].tenant,
        },
      },
      input.claims,
    );
    // Historical evidence survives the live row; authority is still required.
    if (!organization && access !== "history")
      throw new ProblemError(404, "not_found", "Organisation not found");
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "read",
      organizationId: input.organizationId,
    });
    const context = Object.freeze({
      [tenantCommand]: true as const,
      access,
      tx,
      organizationId: input.organizationId,
    });
    issuedContexts.add(context);
    try {
      return await run(context);
    } finally {
      issuedContexts.delete(context);
    }
  });
}

export function requireTenantDirectoryContext(
  context: TenantReadContext<"directory">,
) {
  if (!issuedContexts.has(context) || context.access !== "directory")
    throw new Error("Invalid or expired tenant member directory context");
  return context;
}

export function requireTenantMemberConfigurationContext(
  context: TenantMemberContext | TenantReadContext<"configuration">,
) {
  if (
    !issuedContexts.has(context) ||
    (context.access !== "configuration" && context.access !== "command")
  )
    throw new Error("Invalid or expired tenant member configuration context");
  return context;
}

export function requireTenantMemberAccessContext(
  context: TenantReadContext<"memberAccess">,
) {
  if (!issuedContexts.has(context) || context.access !== "memberAccess")
    throw new Error("Invalid or expired tenant member access context");
  return context;
}

export function requireTenantHistoryContext(
  context: TenantReadContext<"history">,
) {
  if (!issuedContexts.has(context) || context.access !== "history")
    throw new Error("Invalid or expired tenant history context");
  return context;
}
