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
  const { authorizePlatformUsersCommand } =
    await import("../services/platform-context.ts");
  return db.transaction(async (tx) => {
    const authorized = await authorizePlatformUsersCommand(tx, {
      principal: { type: "root", grants: [] },
      environment: testEnvironment({
        rootAdminSecret: "service-test",
        rootAdminBreakGlass: true,
      }),
    });
    try {
      return await authorized.run(run, metadata);
    } finally {
      authorized.close();
    }
  });
}

export async function inPlatformWrite<T>(
  db: Database,
  run: (
    context: import("../services/platform-context.ts").PlatformWriteContext,
  ) => Promise<T>,
  metadata: ActorMetadata = { requestId: "service-test" },
) {
  const { authorizePlatformWriteCommand } =
    await import("../services/platform-context.ts");
  return db.transaction(async (tx) => {
    const authorized = await authorizePlatformWriteCommand(tx, {
      principal: { type: "root", grants: [] },
      environment: testEnvironment({
        rootAdminSecret: "service-test",
        rootAdminBreakGlass: true,
      }),
    });
    try {
      return await authorized.run(run, metadata);
    } finally {
      authorized.close();
    }
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
