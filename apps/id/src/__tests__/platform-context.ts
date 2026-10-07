import type { ActorMetadata } from "../services/actor.ts";
import type { Database, Executor } from "../db/client.ts";
import type { Environment } from "../env.ts";
import type { Principal } from "../http/principal.ts";
import { testEnvironment } from "./support.ts";
import {
  authorizePlatformMutation,
  withPlatformRead,
  type PlatformReadContext,
  type PlatformWriteContext,
} from "../services/platform-context.ts";

/** The break-glass root caller that service fixtures act as. */
export const rootAuthority: { principal: Principal; environment: Environment } =
  {
    principal: { type: "root", grants: [] },
    environment: testEnvironment({
      rootAdminSecret: "service-test",
      rootAdminBreakGlass: true,
    }),
  };

export function inPlatformRead<T>(
  db: Database,
  run: (context: PlatformReadContext) => Promise<T>,
) {
  return withPlatformRead(db, rootAuthority, run);
}

/** One transaction under the authority `authorize` issues, as the journal runs a command. */
export function inPlatformCommand<Context>(
  authorize: (tx: Executor) => Promise<{
    run<T>(
      run: (context: Context) => Promise<T>,
      metadata: ActorMetadata,
    ): Promise<T>;
  }>,
) {
  return <T>(
    db: Database,
    run: (context: Context) => Promise<T>,
    metadata: ActorMetadata = { requestId: "service-test" },
  ) => db.transaction(async (tx) => (await authorize(tx)).run(run, metadata));
}

export const inPlatformUsers = inPlatformCommand((tx) =>
  authorizePlatformMutation(tx, rootAuthority, "users"),
);

export const inPlatformWrite = inPlatformCommand((tx) =>
  authorizePlatformMutation(tx, rootAuthority, "write"),
);

/** Keep service fixtures concise while exercising the real authority/transaction factory. */
export function platformWriteService<Args extends unknown[], Result>(
  run: (context: PlatformWriteContext, ...args: Args) => Promise<Result>,
) {
  return (db: Database, metadata: ActorMetadata, ...args: Args) =>
    inPlatformWrite(db, (context) => run(context, ...args), metadata);
}
