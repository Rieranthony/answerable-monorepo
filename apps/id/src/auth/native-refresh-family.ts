import { APIError } from "better-auth/api";
import type { getOAuthProviderApi } from "@better-auth/oauth-provider";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { grantContexts } from "../db/schema/index.ts";

type Adapter = Parameters<typeof getOAuthProviderApi>[0]["context"]["adapter"];

/** Caller holds the grant row lock inside its transaction, after client authentication. */
export async function withNativeRefreshFamily<T>(
  adapter: Adapter,
  tx: Executor,
  grant: { id: string; clientId: string; userId: string },
  run: (scoped: Adapter) => Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  let invalidating = false;
  const scoped: Adapter = {
    ...adapter,
    findMany: (async (input: Parameters<Adapter["findMany"]>[0]) => {
      if (input.model !== "oauthRefreshToken") return adapter.findMany(input);
      // The pinned native provider starts family invalidation with this lookup.
      // Keep its protocol decision, but replace its client/user family boundary.
      const familyLookup =
        input.where?.length === 2 &&
        [
          ["clientId", grant.clientId],
          ["userId", grant.userId],
        ].every(([field, value]) =>
          input.where!.some(
            (w) =>
              w.field === field &&
              w.value === value &&
              (w.operator === undefined || w.operator === "eq") &&
              (w.connector === undefined || w.connector === "AND"),
          ),
        );
      if (familyLookup) {
        await tx
          .update(grantContexts)
          .set({ revokedAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(grantContexts.id, grant.id),
              isNull(grantContexts.revokedAt),
            ),
          );
        await tx.execute(sql`savepoint native_family_cleanup`);
        invalidating = true;
      }
      return adapter.findMany({
        ...input,
        where: [
          ...(input.where ?? []),
          { field: "referenceId", value: grant.id, connector: "AND" },
        ],
      });
    }) as Adapter["findMany"],
    deleteMany: async (input) =>
      adapter.deleteMany(
        input.model === "oauthRefreshToken"
          ? {
              ...input,
              where: [
                ...input.where,
                { field: "referenceId", value: grant.id, connector: "AND" },
              ],
            }
          : input,
      ),
  };
  try {
    const value = await run(scoped);
    if (invalidating)
      throw new Error(
        "Native family invalidation unexpectedly returned tokens",
      );
    return { value };
  } catch (error) {
    if (!invalidating) throw error;
    // Failed cleanup must not undo the authoritative revocation barrier.
    // Native invalid_grant means cleanup completed; every other failure restores it.
    if (!(error instanceof APIError && error.body?.error === "invalid_grant"))
      await tx.execute(sql`rollback to savepoint native_family_cleanup`);
    await tx.execute(sql`release savepoint native_family_cleanup`);
    return { error };
  }
}
