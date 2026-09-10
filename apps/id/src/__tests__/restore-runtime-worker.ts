import { startRuntime } from "../runtime.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";
import type { Environment } from "../env.ts";

const environment = JSON.parse(await Bun.stdin.text()) as Environment;
assertDisposableTestDatabase(
  "restored service worker",
  environment.databaseUrl,
);
if (!process.send || environment.nodeEnv !== "production")
  throw new Error(
    "Restore startup proof requires its production-mode test parent",
  );
try {
  const runtime = await startRuntime(environment, {
    // Use the production startup path; restrict only the test listener address.
    serve(options) {
      const server = Bun.serve({
        ...options,
        unix: undefined,
        hostname: "127.0.0.1",
      });
      process.send!({ stage: "listening" });
      return server;
    },
  });
  process.send({
    stage: "ready",
    url: `http://127.0.0.1:${runtime.server.port}`,
  });
  process.once("SIGTERM", async () => {
    await runtime.shutdown();
    process.exit(0);
  });
} catch (error) {
  process.send({
    stage: "failed",
    reason:
      error instanceof Error &&
      error.message.startsWith("Unsafe database runtime role:")
        ? "unsafe_role"
        : "unexpected_startup_failure",
  });
  process.exit(1);
}
