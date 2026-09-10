import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import type { Database, Executor } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";

const transactions = new WeakMap<object, Executor>();
const config = { provider: "pg", schema, usePlural: true } as const;

/** Preserve the supported adapter while exposing its actual transaction to policy. */
export function authDatabaseAdapter(
  db: Database,
  onProviderRead?: (row: unknown) => void,
) {
  return (options: BetterAuthOptions) => {
    const adapter = drizzleAdapter(db, { ...config, transaction: true })(
      options,
    );
    return {
      ...adapter,
      findOne: async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
        const row = await adapter.findOne<T>(input);
        if (input.model === "ssoProvider") onProviderRead?.(row);
        return row;
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
