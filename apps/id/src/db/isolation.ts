import { sql } from "drizzle-orm";
import type { Executor } from "./client.ts";

type DatabaseScope =
  | { kind: "none" }
  | { kind: "platform"; access: "read" | "write" }
  | { kind: "tenant"; access: "read" | "write"; organizationId: string }
  | { kind: "policy-user"; userId: string }
  | { kind: "policy-root" }
  | { kind: "platform-users" }
  | { kind: "grant-client"; clientId: string }
  | { kind: "grant-admission"; userId: string; sessionId: string };

/** Trusted transaction owners call this only after establishing authority. */
export async function setDatabaseScope(tx: Executor, scope: DatabaseScope) {
  const mode = "access" in scope ? `${scope.kind}-${scope.access}` : scope.kind;
  await tx.execute(sql`select
    set_config('answerable.scope', ${mode}, true),
    set_config('answerable.tenant', ${scope.kind === "tenant" ? scope.organizationId : ""}, true),
    set_config('answerable.subject', ${"userId" in scope ? scope.userId : ""}, true),
    set_config('answerable.client', ${scope.kind === "grant-client" ? scope.clientId : ""}, true),
    set_config('answerable.session', ${scope.kind === "grant-admission" ? scope.sessionId : ""}, true)`);
}

/** Restore the enclosing trusted scope; errors roll back the savepoint and settings. */
export function withDatabaseScope<T>(
  executor: Executor,
  scope: DatabaseScope,
  run: (tx: Executor) => Promise<T>,
) {
  return executor.transaction(async (tx) => {
    const previous = await tx.execute<{
      mode: string;
      tenant: string;
      subject: string;
      client: string;
      session: string;
    }>(sql`select
      coalesce(current_setting('answerable.scope', true), '') as mode,
      coalesce(current_setting('answerable.tenant', true), '') as tenant,
      coalesce(current_setting('answerable.subject', true), '') as subject,
      coalesce(current_setting('answerable.client', true), '') as client,
      coalesce(current_setting('answerable.session', true), '') as session`);
    await setDatabaseScope(tx, scope);
    const result = await run(tx);
    const saved = previous.rows[0]!;
    await tx.execute(sql`select
      set_config('answerable.scope', ${saved.mode}, true),
      set_config('answerable.tenant', ${saved.tenant}, true),
      set_config('answerable.subject', ${saved.subject}, true),
      set_config('answerable.client', ${saved.client}, true),
      set_config('answerable.session', ${saved.session}, true)`);
    return result;
  });
}
