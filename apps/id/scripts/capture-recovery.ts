import { writeFile } from "node:fs/promises";
import { createDatabase } from "../src/db/client.ts";
import { assertRuntimeRole } from "../src/db/runtime-role.ts";
import { loadEnvironment } from "../src/env.ts";
import { captureRecoveryEvidence } from "../src/operations/recovery.ts";

let connection: ReturnType<typeof createDatabase> | undefined;
try {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath)
    throw new Error("Input and new output paths are required");
  const file = Bun.file(inputPath);
  if (file.size > 1_048_576) throw new Error("Input file is too large");
  connection = createDatabase({ ...loadEnvironment(), databasePoolMax: 1 });
  await assertRuntimeRole(connection.db);
  const evidence = await captureRecoveryEvidence(
    connection.db,
    await file.json(),
  );
  await writeFile(outputPath, JSON.stringify(evidence) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      event: "recovery_evidence_captured",
      scope: "listed_facts_only",
    }),
  );
} catch {
  console.error(JSON.stringify({ event: "recovery_capture_failed" }));
  process.exitCode = 1;
} finally {
  await connection?.close();
}
