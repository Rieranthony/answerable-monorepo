import {
  hydrateSsoProviderRow,
  type PlatformApplications,
} from "./platform-applications.ts";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import { eq } from "drizzle-orm";
import type { Database, Executor } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";

import { setDatabaseScope, withDatabaseScope } from "../db/isolation.ts";

const transactions = new WeakMap<object, Executor>();
const config = { provider: "pg", schema, usePlural: true } as const;

/** Preserve the supported adapter while exposing its actual transaction to policy. */
export function authDatabaseAdapter(
  db: Database,
  onProviderRead?: (rows: unknown[]) => Promise<void>,
  beforeTransaction?: (tx: Executor) => Promise<void>,
  platformApplications: PlatformApplications = {},
) {
  return (options: BetterAuthOptions) => {
    const adapter = drizzleAdapter(db, { ...config, transaction: true })(
      options,
    );
    // Identity matches stay visible to federation so a tombstone is rejected,
    // never treated as an invitation to create or merge another identity.
    const visible = <
      T extends {
        model: string;
        where?: Parameters<typeof adapter.findOne>[0]["where"];
      },
    >(
      input: T,
    ): T =>
      [
        "ssoProvider",
        "organizationDomain",
        "oauthClient",
        "oauthResource",
        "oauthClientResource",
        "oauthConsent",
        "invitation",
      ].includes(input.model)
        ? {
            ...input,
            where: [
              ...(input.where ?? []),
              { field: "deletedAt", value: null },
            ],
          }
        : input;
    const wrap = (base: typeof adapter, tx?: Executor): typeof adapter => ({
      ...base,
      findOne: async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
        let row = await base.findOne<T>(visible(input));
        if (input.model === "ssoProvider") {
          row = hydrateSsoProviderRow(row, platformApplications);
          await onProviderRead?.([row]);
        }
        return row;
      },
      findMany: async <T>(input: Parameters<typeof adapter.findMany>[0]) => {
        let rows = await base.findMany<T>(visible(input));
        if (input.model === "ssoProvider") {
          rows = rows.map((row) =>
            hydrateSsoProviderRow(row, platformApplications),
          );
          await onProviderRead?.(rows);
        }
        return rows;
      },
      // Better Auth locks the provider with an update and compares its returned
      // identity boundary with the configuration read before token exchange.
      // Its organisation is locked first, the order tenant commands lock in, so
      // the membership and session inserts that follow cannot deadlock with a
      // provider command waiting on the provider row.
      update: async <T>(input: Parameters<typeof adapter.update>[0]) => {
        if (tx && input.model === "ssoProvider") {
          const providerId = input.where.find(
            (clause) => clause.field === "providerId",
          )?.value;
          await tx
            .select({ id: schema.organizations.id })
            .from(schema.organizations)
            .innerJoin(
              schema.ssoProviders,
              eq(schema.ssoProviders.organizationId, schema.organizations.id),
            )
            .where(eq(schema.ssoProviders.providerId, String(providerId)))
            .for("key share", { of: schema.organizations });
        }
        const row = await base.update<T>(input);
        return input.model === "ssoProvider"
          ? hydrateSsoProviderRow(row, platformApplications)
          : row;
      },
      count: (input) => base.count(visible(input)),
    });
    // Native SSO provisions organisation membership after its callback transaction.
    // Give standalone member/invitation operations their own protocol transaction.
    const unbound = new Proxy(adapter, {
      get(target, key, receiver) {
        const method = Reflect.get(target, key, receiver);
        if (
          typeof method !== "function" ||
          ![
            "create",
            "findOne",
            "findMany",
            "count",
            "update",
            "updateMany",
            "delete",
            "deleteMany",
          ].includes(String(key))
        )
          return method;
        return (input: { model: string }) => {
          if (!["member", "invitation"].includes(input.model))
            return Reflect.apply(method, target, [input]);
          return withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
            const bound = drizzleAdapter(tx, config)(options);
            return Reflect.apply(Reflect.get(bound, key), bound, [input]);
          });
        };
      },
    });
    return {
      ...wrap(unbound),
      transaction: async <T>(
        run: (boundAdapter: typeof adapter) => Promise<T>,
      ) =>
        db.transaction(async (tx) => {
          await setDatabaseScope(tx, { kind: "protocol" });
          await beforeTransaction?.(tx);
          const bound = wrap(drizzleAdapter(tx, config)(options), tx);
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
