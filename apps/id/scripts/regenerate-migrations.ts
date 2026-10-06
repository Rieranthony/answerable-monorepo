// Pre-production only. Rebuilds drizzle/ as 0000_initial.sql, generated from the schema
// modules, and 0001_invariants.sql, kept as reviewed. Delete this script after the first
// production migration; from then on `db:generate` adds migrations.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const folder = join(app, "drizzle");
const invariants = await readFile(join(folder, "0001_invariants.sql"), "utf8");
const previous = await mkdtemp(join(tmpdir(), "id-drizzle-"));

function generate(...options: string[]) {
  const { exitCode } = Bun.spawnSync(
    [process.execPath, "run", "db:generate", ...options],
    { cwd: app, stdout: "inherit", stderr: "inherit" },
  );
  if (exitCode !== 0)
    throw new Error(`drizzle-kit generate ${options.join(" ")} failed`);
}
const read = (directory: string, file: string) =>
  readFile(join(directory, file), "utf8");
const tags = async (directory: string) =>
  (
    JSON.parse(await read(directory, "meta/_journal.json")) as {
      entries: { tag: string }[];
    }
  ).entries
    .map(({ tag }) => tag)
    .join();

try {
  await cp(folder, previous, { recursive: true });
  await rm(folder, { recursive: true });
  generate("--name", "initial");
  generate("--custom", "--name", "invariants");
  await writeFile(join(folder, "0001_invariants.sql"), invariants);
  // Without a schema change, keep the journal times and snapshot ids as well, so the
  // folder is unchanged and existing databases still match their receipts.
  const unchanged =
    (await read(folder, "0000_initial.sql")) ===
      (await read(previous, "0000_initial.sql")) &&
    (await tags(folder)) === (await tags(previous));
  if (unchanged)
    await cp(join(previous, "meta"), join(folder, "meta"), { recursive: true });
  console.log(
    unchanged
      ? "The schema modules generate the committed 0000_initial.sql; drizzle/ is unchanged"
      : "Regenerated drizzle/; recreate existing databases, then run the tests",
  );
} catch (error) {
  await rm(folder, { recursive: true, force: true });
  await cp(previous, folder, { recursive: true });
  throw error;
} finally {
  await rm(previous, { recursive: true, force: true });
}
