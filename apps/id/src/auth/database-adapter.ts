import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import type { Database, Executor } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";

const transactions = new WeakMap<object, Executor>();
const config = { provider: "pg", schema, usePlural: true } as const;

/** Preserve the supported adapter while exposing its actual transaction to policy. */
export function authDatabaseAdapter(
  db: Database,
  onProviderRead?: (rows: unknown[]) => Promise<void>,
) {
  return (options: BetterAuthOptions) => {
    const adapter = drizzleAdapter(db, { ...config, transaction: true })(
      options,
    );
    return {
      ...adapter,
      findOne: async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
        const row = await adapter.findOne<T>(input);
        if (input.model === "ssoProvider") await onProviderRead?.([row]);
        return row;
      },
      findMany: async <T>(input: Parameters<typeof adapter.findMany>[0]) => {
        const rows = await adapter.findMany<T>(input);
        if (input.model === "ssoProvider") await onProviderRead?.(rows);
        return rows;
      },
      transaction: async <T>(
        run: (boundAdapter: typeof adapter) => Promise<T>,
      ) =>
        db.transaction(async (tx) => {
          const bound = drizzleAdapter(tx, config)(options);
          transactions.set(bound, tx);
          try {
            return await run(bound);
          } finally {
            transactions.delete(bound);
          }
        }),
    };
  };
}

export function authTransaction(adapter: object): Executor {
  const tx = transactions.get(adapter);
  if (!tx) throw new Error("An active authentication transaction is required");
  return tx;
}
