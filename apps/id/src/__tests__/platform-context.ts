import type { ActorMetadata } from "../services/actor.ts";
import type { Database } from "../db/client.ts";
import { testEnvironment } from "./support.ts";
import {
  withPlatformRead,
  type PlatformReadContext,
} from "../services/platform-context.ts";
export function inPlatformRead<T>(
  db: Database,
  run: (context: PlatformReadContext) => Promise<T>,
) {
  return withPlatformRead(
    db,
    {
      principal: { type: "root", grants: [] },
      environment: testEnvironment({
        rootAdminSecret: "service-test",
        rootAdminBreakGlass: true,
      }),
    },
    run,
  );
}

export async function inPlatformUsers<T>(
  db: Database,
  run: (
    context: import("../services/platform-context.ts").PlatformUsersContext,
  ) => Promise<T>,
  metadata: ActorMetadata = { requestId: "service-test" },
) {
  const { authorizePlatformMutation } =
    await import("../services/platform-context.ts");
  return db.transaction(async (tx) => {
    const authorized = await authorizePlatformMutation(
      tx,
      {
        principal: { type: "root", grants: [] },
        environment: testEnvironment({
          rootAdminSecret: "service-test",
          rootAdminBreakGlass: true,
        }),
      },
      "users",
    );
    return authorized.run(run, metadata);
  });
}

export async function inPlatformWrite<T>(
  db: Database,
  run: (
    context: import("../services/platform-context.ts").PlatformWriteContext,
  ) => Promise<T>,
  metadata: ActorMetadata = { requestId: "service-test" },
) {
  const { authorizePlatformMutation } =
    await import("../services/platform-context.ts");
  return db.transaction(async (tx) => {
    const authorized = await authorizePlatformMutation(
      tx,
      {
        principal: { type: "root", grants: [] },
        environment: testEnvironment({
          rootAdminSecret: "service-test",
          rootAdminBreakGlass: true,
        }),
      },
      "write",
    );
    return authorized.run(run, metadata);
  });
}

/** Keep service fixtures concise while exercising the real authority/transaction factory. */
export function platformWriteService<Args extends unknown[], Result>(
  run: (
    context: import("../services/platform-context.ts").PlatformWriteContext,
    ...args: Args
  ) => Promise<Result>,
) {
  return (db: Database, metadata: ActorMetadata, ...args: Args) =>
    inPlatformWrite(db, (context) => run(context, ...args), metadata);
}
