import { createDatabase } from "../src/db/client.ts";
import { assertRuntimeRole } from "../src/db/runtime-role.ts";
import { loadEnvironment } from "../src/env.ts";
import { verifyRecoveryEvidence } from "../src/operations/recovery.ts";

let connection: ReturnType<typeof createDatabase> | undefined;
try {
  const path = process.argv[2];
  if (!path)
    throw new Error("An independently retained evidence file is required");
  const file = Bun.file(path);
  if (file.size > 1_048_576) throw new Error("Evidence file is too large");
  const input: unknown = await file.json();
  connection = createDatabase({ ...loadEnvironment(), databasePoolMax: 1 });
  await assertRuntimeRole(connection.db);
  const counts = await verifyRecoveryEvidence(connection.db, input);
  console.log(
    JSON.stringify({
      event: "recovery_evidence_matches",
      ...counts,
      scope: "listed_facts_only",
      traffic: "requires_operator_release",
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      event: "recovery_verification_failed",
      traffic: "keep_closed",
    }),
  );
  process.exitCode = 1;
} finally {
  await connection?.close();
}
