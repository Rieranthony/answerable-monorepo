import { loadEnvironment } from "./env.ts";
import { startRuntime } from "./runtime.ts";

const environment = loadEnvironment();
const runtime = await startRuntime(environment);

const shutdown = () =>
  void runtime.shutdown().catch((error: unknown) => {
    // The name only: driver errors can carry credentials in their message.
    console.error(
      "[id] error",
      JSON.stringify({
        event: "shutdown_failed",
        name: error instanceof Error ? error.name : typeof error,
      }),
    );
    process.exitCode = 1;
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Answerable ID listening on ${runtime.server.url}`);
