import type { NativeAdapter } from "./native-client-authentication.ts";
import { APIError } from "better-auth/api";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { revokeGrantContexts } from "../db/queries/grant-contexts.ts";
import { grantContexts, oauthClients } from "../db/schema/index.ts";

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
  adapter: NativeAdapter,
  tx: Executor,
  input: { clientId: string; authorizationCodeId: string },
  run: (scoped: NativeAdapter) => Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  let invalidating = false;
  const scoped: NativeAdapter = {
    ...adapter,
    deleteMany: async (query) => {
      const cleanup =
        (query.model === "oauthAccessToken" ||
          query.model === "oauthRefreshToken") &&
        query.where.length === 1 &&
        query.where.some(
          (w) =>
            w.field === "authorizationCodeId" &&
            w.value === input.authorizationCodeId &&
            (w.operator === undefined || w.operator === "eq") &&
            (w.connector === undefined || w.connector === "AND"),
        );
      if (cleanup && !invalidating) {
        await revokeGrantContexts(
          tx,
          and(
            eq(grantContexts.authorizationCodeId, input.authorizationCodeId),
            inArray(
              grantContexts.clientInstanceId,
              tx
                .select({ id: oauthClients.id })
                .from(oauthClients)
                .where(eq(oauthClients.clientId, input.clientId)),
            ),
          )!,
        );
        await tx.execute(sql`savepoint native_code_cleanup`);
        invalidating = true;
      }
      // The pinned provider deletes only token rows here (native-shapes.test.ts).
      return adapter.deleteMany({
        ...query,
        where: [
          ...query.where,
          { field: "clientId", value: input.clientId, connector: "AND" },
        ],
      });
    },
  };
  try {
    const value = await run(scoped);
    return { value };
  } catch (error) {
    if (!invalidating) throw error;
    if (!(error instanceof APIError && error.body?.error === "invalid_grant"))
      await tx.execute(sql`rollback to savepoint native_code_cleanup`);
    await tx.execute(sql`release savepoint native_code_cleanup`);
    return { error };
  }
}
