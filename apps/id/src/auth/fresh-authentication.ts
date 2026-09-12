import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { sessions } from "../db/schema/index.ts";
import { ProblemError } from "../http/problem.ts";

export const freshAuthenticationSeconds = 300;

export async function isFreshAuthentication(tx: Executor, time: Date | null) {
  const result =
    await tx.execute(sql`select ${time?.toISOString() ?? null}::timestamptz
    between statement_timestamp() - make_interval(secs => ${freshAuthenticationSeconds})
    and statement_timestamp() as fresh`);
  return result.rows[0]!.fresh === true;
}

/** Call after current authority is locked. Keep the immutable timestamp so an
 * authorised self-revocation can remove its session in the same transaction.
 */
export async function freshAuthenticationGuard(
  tx: Executor,
  sessionId: string,
) {
  const [session] = await tx
    .select({ time: sessions.upstreamAuthTime })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const time = session?.time ?? null;
  const check = async () => {
    if (!(await isFreshAuthentication(tx, time)))
      throw new ProblemError(
        403,
        "reauthentication_required",
        "Fresh SSO authentication is required",
        "Reauthenticate through your current identity provider, then retry the same key and input.",
        {
          reauthenticationPath: "/auth/sso/reauthenticate",
          maxAge: freshAuthenticationSeconds,
        },
      );
  };
  await check();
  return check;
}
