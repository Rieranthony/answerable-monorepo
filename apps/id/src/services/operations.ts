import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, Executor } from "../db/client.ts";
import { adminOperations } from "../db/schema/index.ts";
import { ProblemError } from "../http/problem.ts";
import { createId } from "../lib/id.ts";

export type OperationJson =
  | null
  | boolean
  | number
  | string
  | OperationJson[]
  | { [key: string]: OperationJson };
type Json = OperationJson;

/** Callers supply validated, defaulted JSON; domain sets must already be sorted. */
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Operation input must be finite JSON");
  return JSON.stringify(value);
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Command = {
  actorInstance: string;
  authorityScope: string;
  name: string;
  key: string;
  input: Json;
};
type Result = Pick<
  typeof adminOperations.$inferInsert,
  "outcome" | "statusCode" | "resultReference"
>;

/** One transaction, one retained key. No network work belongs in either callback. */
export function executeOperation<Authority>(
  db: Database,
  command: Command,
  authorize: (tx: Executor) => Promise<Authority>,
  mutate: (
    tx: Executor,
    operationId: string,
    authority: Authority,
  ) => Promise<Result & { body?: Json }>,
  releaseAuthority?: (authority: Authority) => void,
) {
  if (!command.key.length || command.key.length > 256)
    throw new ProblemError(
      400,
      "invalid_idempotency_key",
      "Idempotency key must contain 1–256 characters",
    );
  const identity = {
    actorInstance: command.actorInstance,
    authorityScope: command.authorityScope,
    name: command.name,
    keyDigest: digest(command.key),
  };
  const fingerprint = digest(canonical({ identity, input: command.input }));
  return db.transaction(async (tx) => {
    // A hash collision can only serialise unrelated commands, never replay one.
    const lock = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${canonical(identity)}, 0)) as acquired`,
    );
    const authority = await authorize(tx);
    try {
      if (!lock.rows[0]!.acquired)
        throw new ProblemError(
          409,
          "operation_in_progress",
          "Operation is in progress",
          "Retry with the same key and input.",
          { retryable: true },
        );
      const [existing] = await tx
        .select()
        .from(adminOperations)
        .where(
          and(
            eq(adminOperations.actorInstance, identity.actorInstance),
            eq(adminOperations.authorityScope, identity.authorityScope),
            eq(adminOperations.name, identity.name),
            eq(adminOperations.keyDigest, identity.keyDigest),
          ),
        );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ProblemError(
            409,
            "idempotency_key_reused",
            "Idempotency key was used for different input",
            undefined,
            { retryable: false },
          );
        return {
          operation: existing,
          replayed: true,
          body: {
            operationId: existing.id,
            outcome: existing.outcome,
            statusCode: existing.statusCode,
            resultReference: existing.resultReference,
          },
        };
      }
      const id = createId();
      const { body, ...result } = await mutate(tx, id, authority);
      const [operation] = await tx
        .insert(adminOperations)
        .values({ id, ...identity, fingerprint, ...result })
        .returning();
      return { operation: operation!, replayed: false, body };
    } finally {
      releaseAuthority?.(authority);
    }
  });
}
