import type { getOAuthProviderApi } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { grantContexts, oauthClients } from "../db/schema/index.ts";
type Adapter = Parameters<typeof getOAuthProviderApi>[0]["context"]["adapter"];

/** Bind only inside successful native issuance's transaction; the DB prevents replacement. */
export async function bindGrantCode(
  tx: Executor,
  id: string,
  authorizationCodeId: string,
) {
  const rows = await tx
    .update(grantContexts)
    .set({ authorizationCodeId })
    .where(and(eq(grantContexts.id, id), isNull(grantContexts.revokedAt)))
    .returning({ id: grantContexts.id });
  if (!rows.length)
    throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
}

/** Caller has authenticated this client; native code decides whether replay cleanup runs. */
export async function withNativeCodeReplay<T>(
  adapter: Adapter,
  tx: Executor,
  input: { clientId: string; authorizationCodeId: string },
  run: (scoped: Adapter) => Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  let invalidating = false;
  const scoped: Adapter = {
    ...adapter,
    deleteMany: async (query) => {
      const token =
        query.model === "oauthAccessToken" ||
        query.model === "oauthRefreshToken";
      const cleanup =
        token &&
        query.where.length === 1 &&
        query.where.some(
          (w) =>
            w.field === "authorizationCodeId" &&
            w.value === input.authorizationCodeId &&
            (w.operator === undefined || w.operator === "eq") &&
            (w.connector === undefined || w.connector === "AND"),
        );
      if (cleanup && !invalidating) {
        await tx
          .update(grantContexts)
          .set({ revokedAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(grantContexts.authorizationCodeId, input.authorizationCodeId),
              inArray(
                grantContexts.clientInstanceId,
                tx
                  .select({ id: oauthClients.id })
                  .from(oauthClients)
                  .where(eq(oauthClients.clientId, input.clientId)),
              ),
              isNull(grantContexts.revokedAt),
            ),
          );
        await tx.execute(sql`savepoint native_code_cleanup`);
        invalidating = true;
      }
      return adapter.deleteMany(
        token
          ? {
              ...query,
              where: [
                ...query.where,
                { field: "clientId", value: input.clientId, connector: "AND" },
              ],
            }
          : query,
      );
    },
  };
  try {
    const value = await run(scoped);
    if (invalidating)
      throw new Error("Native code replay unexpectedly returned tokens");
    return { value };
  } catch (error) {
    if (!invalidating) throw error;
    if (!(error instanceof APIError && error.body?.error === "invalid_grant"))
      await tx.execute(sql`rollback to savepoint native_code_cleanup`);
    await tx.execute(sql`release savepoint native_code_cleanup`);
    return { error };
  }
}
