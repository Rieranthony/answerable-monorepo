import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, Executor } from "../db/client.ts";
import { adminOperations, adminOperationResults } from "../db/schema/index.ts";
import { ProblemError } from "../http/problem.ts";
import { createId } from "../lib/id.ts";

import type {
  OperationCipher,
  OperationJson as Json,
} from "./operation-cipher.ts";

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
  replay?: { cipher: OperationCipher; retention: "secret" | "ordinary" },
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
  const canonicalInput = canonical(command.input);
  const boundInput = canonical({ identity, input: command.input });
  const fingerprint = replay
    ? replay.cipher.fingerprint(boundInput)
    : digest(canonicalInput);
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
        const stored =
          existing.replayExpiresAt === null
            ? undefined
            : (
                await tx
                  .select()
                  .from(adminOperationResults)
                  .where(eq(adminOperationResults.operationId, existing.id))
              )[0];
        // Expired reservations never execute again, even after old keys are retired.
        if (
          existing.replayExpiresAt !== null &&
          (existing.replayExpiresAt.getTime() <= Date.now() || !stored)
        )
          throw new ProblemError(
            410,
            "operation_result_expired",
            "Operation result has expired",
            "The command will not run again. Use a new key for a deliberate new operation.",
            {
              retryable: false,
              operationId: existing.id,
              resultReference: existing.resultReference,
            },
          );
        const referenceFingerprint =
          existing.replayExpiresAt === null &&
          /^[a-f0-9]{64}$/.test(existing.fingerprint);
        if (
          (existing.replayExpiresAt !== null || !referenceFingerprint) &&
          !replay
        )
          throw new ProblemError(
            503,
            "operation_replay_unavailable",
            "Replay decryption is not configured",
            undefined,
            { retryable: true },
          );
        let matches: boolean;
        if (referenceFingerprint) {
          // Reference-only internal operations do not retain encrypted responses.
          matches = existing.fingerprint === digest(canonicalInput);
        } else {
          try {
            matches = replay!.cipher.matchesFingerprint(
              boundInput,
              existing.fingerprint,
            );
          } catch {
            throw new ProblemError(
              503,
              "operation_replay_unavailable",
              "Operation fingerprint could not be verified",
              undefined,
              { retryable: true },
            );
          }
        }
        if (!matches)
          throw new ProblemError(
            409,
            "idempotency_key_reused",
            "Idempotency key was used for different input",
            undefined,
            { retryable: false },
          );
        if (existing.replayExpiresAt !== null) {
          let body: Json;
          try {
            body = await replay!.cipher.decrypt(
              existing.id,
              stored!.ciphertext,
            );
          } catch {
            throw new ProblemError(
              503,
              "operation_replay_unavailable",
              "Operation replay could not be decrypted",
              undefined,
              { retryable: true },
            );
          }
          return { operation: existing, replayed: true, body };
        }
        return { operation: existing, replayed: true };
      }
      const id = createId();
      const { body, ...result } = await mutate(tx, id, authority);
      const replayExpiresAt = replay
        ? new Date(
            Date.now() +
              (replay.retention === "secret" ? 24 : 168) * 60 * 60 * 1000,
          )
        : null;
      if (body !== undefined && !replay)
        throw new Error("Response recovery requires replay encryption");
      const [operation] = await tx
        .insert(adminOperations)
        .values({ id, ...identity, fingerprint, ...result, replayExpiresAt })
        .returning();
      if (replay) {
        await tx.insert(adminOperationResults).values({
          operationId: id,
          ciphertext: await replay.cipher.encrypt(id, body ?? null),
        });
        return { operation: operation!, replayed: false, body: body ?? null };
      }
      return { operation: operation!, replayed: false };
    } finally {
      releaseAuthority?.(authority);
    }
  });
}
