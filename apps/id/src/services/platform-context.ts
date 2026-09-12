import {
  actorIdentity,
  commandActor,
  type Actor,
  type ActorMetadata,
} from "./actor.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import type { Database, Executor } from "../db/client.ts";
import type { Environment } from "../env.ts";
import type { Principal, BearerClaims } from "../http/principal.ts";
import { authorizeCommand } from "./command-authority.ts";

const platformRead = Symbol("platformRead");
const activeContexts = new WeakSet<PlatformReadContext>();
export type PlatformReadContext = Readonly<{
  [platformRead]: true;
  tx: Executor;
}>;

type PlatformCaller = {
  freshAuthentication?: boolean;
  principal: Principal;
  environment: Environment;
  claims?: BearerClaims;
};

/** Current platform:read only; tenant grants cannot create this context. */
export function withPlatformRead<T>(
  db: Database,
  caller: PlatformCaller,
  run: (context: PlatformReadContext) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      { platform: "platform:read" },
      caller.claims,
    );
    await setDatabaseScope(tx, { kind: "platform", access: "read" });
    const context = Object.freeze({ [platformRead]: true as const, tx });
    activeContexts.add(context);
    try {
      return await run(context);
    } finally {
      activeContexts.delete(context);
    }
  });
}

export function requirePlatformReadContext(context: PlatformReadContext) {
  if (!activeContexts.has(context))
    throw new Error("Invalid or expired platform read context");
  return context;
}

const platformMutation = Symbol("platformMutation");
const activeMutationContexts = new WeakSet<object>();
type PlatformMutationContext<Access extends "users" | "write"> = Readonly<{
  revalidate: () => Promise<void>;
  [platformMutation]: true;
  access: Access;
  actor: Readonly<Actor>;
  tx: Executor;
}>;
export type PlatformUsersContext = PlatformMutationContext<"users">;
export type PlatformWriteContext = PlatformMutationContext<"write">;

async function authorizePlatformMutation<Access extends "users" | "write">(
  tx: Executor,
  caller: PlatformCaller,
  access: Access,
) {
  caller = { ...caller, principal: { ...caller.principal } };
  const identity = actorIdentity(caller.principal);
  const authorize = () =>
    authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      {
        platform: access === "users" ? "platform:users" : "platform:write",
        freshAuthentication: caller.freshAuthentication,
      },
      caller.claims,
    );
  await authorize();
  await setDatabaseScope(
    tx,
    access === "write"
      ? { kind: "platform", access: "write" }
      : { kind: "platform-users" },
  );
  let active = true;
  return {
    close() {
      active = false;
    },
    async run<T>(
      run: (context: PlatformMutationContext<Access>) => Promise<T>,
      metadata: ActorMetadata,
    ): Promise<T> {
      if (!active)
        throw new Error("Invalid or expired platform command authorisation");
      active = false;
      const context = Object.freeze({
        [platformMutation]: true as const,
        access,
        actor: commandActor(identity, metadata),
        tx,
        async revalidate() {
          if (caller.principal.type === "user") await authorize();
        },
      });
      activeMutationContexts.add(context);
      try {
        return await run(context);
      } finally {
        activeMutationContexts.delete(context);
      }
    },
  };
}

/** Fixed authority is checked before replay; the runner is owned by the journal. */
export function authorizePlatformUsersCommand(
  tx: Executor,
  caller: PlatformCaller,
) {
  return authorizePlatformMutation(tx, caller, "users");
}
export function authorizePlatformWriteCommand(
  tx: Executor,
  caller: PlatformCaller,
) {
  return authorizePlatformMutation(tx, caller, "write");
}
export function requirePlatformUsersContext(context: PlatformUsersContext) {
  if (!activeMutationContexts.has(context) || context.access !== "users")
    throw new Error("Invalid or expired platform users context");
  return context;
}
export function requirePlatformWriteContext(context: PlatformWriteContext) {
  if (!activeMutationContexts.has(context) || context.access !== "write")
    throw new Error("Invalid or expired platform write context");
  return context;
}
