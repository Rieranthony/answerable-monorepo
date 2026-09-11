import { startRuntime } from "../runtime.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";
import type { Environment } from "../env.ts";

const environment = JSON.parse(await Bun.stdin.text()) as Environment;
assertDisposableTestDatabase(
  "run synthetic capacity worker",
  environment.databaseUrl,
);
if (
  !process.send ||
  new URL(environment.databaseUrl).port !== "47432" ||
  !["localhost", "127.0.0.1"].includes(
    new URL(environment.databaseUrl).hostname,
  )
)
  throw new Error("Capacity worker requires its local test parent");
const runtime = await startRuntime(environment, {
  serve: (options) =>
    Bun.serve({ ...options, unix: undefined, hostname: "127.0.0.1" }),
});
process.send({
  stage: "ready",
  url: `http://127.0.0.1:${runtime.server.port}`,
});
process.on("message", (message) => {
  if (message === "snapshot")
    process.send!({ stage: "summary", summary: runtime.metrics.snapshot() });
});
process.once("SIGTERM", async () => {
  await runtime.shutdown();
  process.exit(0);
});
