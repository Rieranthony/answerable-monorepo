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
export type PlatformReadContext = Readonly<{
  [platformRead]: true;
  tx: Executor;
}>;

type PlatformCaller = {
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
    return run({ [platformRead]: true, tx });
  });
}

const platformMutation = Symbol("platformMutation");
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
  const identity = actorIdentity(caller.principal);
  const authorize = () =>
    authorizeCommand(
      tx,
      caller.principal,
      caller.environment,
      { platform: access === "users" ? "platform:users" : "platform:write" },
      caller.claims,
    );
  await authorize();
  await setDatabaseScope(
    tx,
    access === "write"
      ? { kind: "platform", access: "write" }
      : { kind: "platform-users" },
  );
  return {
    /** The actor needs the operation id, which exists only after authorisation. */
    run<T>(
      run: (context: PlatformMutationContext<Access>) => Promise<T>,
      metadata: ActorMetadata,
    ): Promise<T> {
      return run({
        [platformMutation]: true,
        access,
        actor: commandActor(identity, metadata),
        tx,
        async revalidate() {
          if (caller.principal.type === "user") await authorize();
        },
      });
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
